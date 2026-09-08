import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Option,
  Predicate,
  Ref,
  Schema,
  TxSubscriptionRef,
  type Semaphore,
  type Stream,
} from "effect"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { QueueSnapshot } from "../../domain/queue.js"
import { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import {
  AgentLoopError,
  appendFollowUpQueueState,
  appendSteeringItem,
  buildRunningState,
  clearInFlightQueuedTurn,
  countQueuedFollowUps,
  drainVisibleQueueItems,
  projectRuntimeState,
  queueSnapshotFromQueueState,
  removeQueuedFollowUp,
  takeNextQueuedTurn,
  type AgentLoopState,
  type LoopQueueState,
  type LoopState,
  type QueuedTurnItem,
  type RunningState,
  type SessionRuntimeState,
} from "./agent-loop.state.js"

const FOLLOW_UP_QUEUE_MAX = 10

export type AgentLoopQueueContext = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly loopRef: TxSubscriptionRef.TxSubscriptionRef<AgentLoopState>
  readonly queuePersistenceSemaphore: Semaphore.Semaphore
  readonly persistenceFailure: Deferred.Deferred<void, AgentLoopError>
  readonly startedRef: Ref.Ref<boolean>
}

export type AgentLoopQueue = {
  readonly readState: Effect.Effect<AgentLoopState>
  readonly stateChanges: Stream.Stream<AgentLoopState>
  readonly runtimeState: Effect.Effect<SessionRuntimeState>
  readonly queueSnapshot: Effect.Effect<QueueSnapshot>
  readonly currentLoopState: Effect.Effect<LoopState>
  readonly persistRuntimeState: (state: LoopState) => Effect.Effect<void, AgentLoopError>
  readonly refreshRuntimeState: Effect.Effect<void, AgentLoopError>
  readonly setStartingState: (state: RunningState) => Effect.Effect<void>
  readonly reserveStartOrQueueFollowUp: (
    item: QueuedTurnItem,
    options: { readonly queueOnly: boolean },
  ) => Effect.Effect<Option.Option<RunningState>, AgentLoopError>
  readonly reserveRunStartOrQueueFollowUp: (
    item: QueuedTurnItem,
  ) => Effect.Effect<Option.Option<RunStartReservation>, AgentLoopError>
  readonly takeNextQueuedTurnIfIdle: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  readonly takeNextQueuedTurn: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  readonly clearInFlightTurn: (
    messageId: QueuedTurnItem["message"]["id"],
  ) => Effect.Effect<void, AgentLoopError>
  readonly appendSteering: (item: QueuedTurnItem) => Effect.Effect<LoopState, AgentLoopError>
  /**
   * Remove the steering items a running turn can deliver at its next step
   * boundary. Items with an agent override or run spec need their own turn
   * profile and stay queued for the turn boundary.
   */
  readonly takeSteeringForStep: Effect.Effect<ReadonlyArray<QueuedTurnItem>, AgentLoopError>
  readonly drainQueue: Effect.Effect<QueueSnapshot, AgentLoopError>
  /** True when a queued follow-up was removed; false when it was absent or already in flight. */
  readonly removeFollowUp: (
    messageId: QueuedTurnItem["message"]["id"],
  ) => Effect.Effect<boolean, AgentLoopError>
  readonly saveCheckpoint: (next: LoopState) => Effect.Effect<void, AgentLoopError>
}

interface RunStartReservation {
  readonly stateEpochBaseline: number
  readonly turnFailureBaseline: number
}

const mergeConcurrentLoopMetadata = (
  base: AgentLoopState,
  current: AgentLoopState,
  next: AgentLoopState,
): AgentLoopState => {
  if (current.turnFailure === base.turnFailure) return next
  const merged = { ...next }
  if (Predicate.isUndefined(current.turnFailure)) {
    delete merged.turnFailure
  } else {
    merged.turnFailure = current.turnFailure
  }
  return merged
}

export const makeAgentLoopQueue = (
  scope: AgentLoopQueueContext,
): Effect.Effect<AgentLoopQueue, never, AgentLoopQueueStorage> =>
  Effect.gen(function* () {
    const queueStorage = yield* AgentLoopQueueStorage

    const persistCommittedQueue = (queue: LoopQueueState, operation: string) =>
      Effect.flatMap(Ref.get(scope.startedRef), (started) => {
        if (!started) return Effect.void
        return queueStorage.putQueueState(scope.sessionId, scope.branchId, queue).pipe(
          Effect.mapError(
            (cause) =>
              new AgentLoopError({
                message: `Failed to persist ${operation} for ${scope.sessionId}/${scope.branchId}`,
                cause,
              }),
          ),
        )
      })

    const recordPersistenceFailure = (error: AgentLoopError) =>
      Deferred.fail(scope.persistenceFailure, error).pipe(Effect.catchEager(() => Effect.void))

    const commitQueueTransaction = <A>(
      operation: string,
      decide: (state: AgentLoopState) => {
        readonly value: A
        readonly next: AgentLoopState
        readonly persist: boolean
      },
    ): Effect.Effect<A, AgentLoopError> =>
      Effect.gen(function* () {
        const base = yield* TxSubscriptionRef.get(scope.loopRef)
        const next = decide(base)
        let committed = next.next
        if (next.persist) {
          committed = {
            ...next.next,
            stateEpoch: next.next.stateEpoch + 1,
          }
        }
        const decision = { ...next, next: committed }
        if (decision.persist) {
          yield* persistCommittedQueue(decision.next.queue, operation).pipe(
            Effect.tapError(recordPersistenceFailure),
          )
        }
        yield* TxSubscriptionRef.update(scope.loopRef, (current) =>
          mergeConcurrentLoopMetadata(base, current, decision.next),
        )
        return decision.value
      }).pipe(scope.queuePersistenceSemaphore.withPermits(1))

    const persistRuntimeState = (state: LoopState) =>
      TxSubscriptionRef.get(scope.loopRef)
        .pipe(
          Effect.flatMap((s) =>
            queueStorage.putQueueState(scope.sessionId, scope.branchId, s.queue).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentLoopError({
                    message: `Failed to persist loop queue for ${scope.sessionId}/${scope.branchId}`,
                    cause,
                  }),
              ),
              Effect.andThen(
                TxSubscriptionRef.update(scope.loopRef, (current) => {
                  const next: AgentLoopState = {
                    state,
                    queue: current.queue,
                    stateEpoch: current.stateEpoch + 1,
                  }
                  if (!Predicate.isUndefined(current.turnFailure)) {
                    return Object.assign(next, { turnFailure: current.turnFailure })
                  }
                  return next
                }),
              ),
            ),
          ),
        )
        .pipe(scope.queuePersistenceSemaphore.withPermits(1))

    const currentLoopState = TxSubscriptionRef.get(scope.loopRef).pipe(Effect.map((s) => s.state))
    const readState = TxSubscriptionRef.get(scope.loopRef)
    const stateChanges = TxSubscriptionRef.changesStream(scope.loopRef)
    const runtimeState: Effect.Effect<SessionRuntimeState> = readState.pipe(
      Effect.map(projectRuntimeState),
    )
    const queueState = readState.pipe(Effect.map((s) => s.queue))
    const queueSnapshot: Effect.Effect<QueueSnapshot> = queueState.pipe(
      Effect.map(queueSnapshotFromQueueState),
    )

    const setStartingState = Effect.fn("AgentLoop.setStartingState")((state: RunningState) =>
      TxSubscriptionRef.update(scope.loopRef, (s) => ({
        ...s,
        startingState: state,
      })),
    )

    const reserveStartOrQueueFollowUp = Effect.fn("AgentLoop.reserveStartOrQueueFollowUp")(
      function* (item: QueuedTurnItem, options: { readonly queueOnly: boolean }) {
        const startedAtMs = yield* Clock.currentTimeMillis
        return yield* commitQueueTransaction<Option.Option<RunningState> | AgentLoopError>(
          "reserved or queued follow-up",
          (current) => {
            if (countQueuedFollowUps(current.queue) >= FOLLOW_UP_QUEUE_MAX) {
              return {
                value: new AgentLoopError({
                  message: `Follow-up queue full (max ${FOLLOW_UP_QUEUE_MAX})`,
                }),
                next: current,
                persist: false,
              }
            }

            const nextQueue = appendFollowUpQueueState(current.queue, item)
            if (options.queueOnly) {
              return {
                value: Option.none(),
                next: { ...current, queue: nextQueue },
                persist: true,
              }
            }

            if (!Predicate.isUndefined(current.startingState)) {
              return {
                value: Option.none(),
                next: {
                  ...current,
                  queue: nextQueue,
                },
                persist: true,
              }
            }

            const projectedState = projectRuntimeState(current)
            if (projectedState._tag !== "Idle" || current.state._tag !== "Idle") {
              return {
                value: Option.none(),
                next: { ...current, queue: nextQueue },
                persist: true,
              }
            }

            const reservedRunningState = buildRunningState(current.state, item, { startedAtMs })
            return {
              value: Option.some(reservedRunningState),
              next: { ...current, startingState: reservedRunningState },
              persist: false,
            }
          },
        ).pipe(
          Effect.filterOrFail(
            (value): value is Option.Option<RunningState> => !Schema.is(AgentLoopError)(value),
            (value) => {
              if (Schema.is(AgentLoopError)(value)) return value
              return new AgentLoopError({ message: "Queue transaction returned an invalid value" })
            },
          ),
        )
      },
    )

    const reserveRunStartOrQueueFollowUp = Effect.fn("AgentLoop.reserveRunStartOrQueueFollowUp")(
      function* (item: QueuedTurnItem) {
        const startedAtMs = yield* Clock.currentTimeMillis
        return yield* commitQueueTransaction<Option.Option<RunStartReservation>>(
          "run start reservation",
          (current) => {
            if (current.state._tag !== "Idle" || !Predicate.isUndefined(current.startingState)) {
              const state = Option.getOrElse(
                Option.fromUndefinedOr(current.startingState),
                () => current.state,
              )
              return {
                value: Option.none(),
                next: { ...current, state, queue: appendFollowUpQueueState(current.queue, item) },
                persist: true,
              }
            }

            return {
              value: Option.some({
                stateEpochBaseline: current.stateEpoch,
                turnFailureBaseline: Option.getOrElse(
                  Option.fromUndefinedOr(current.turnFailure).pipe(
                    Option.map(({ epoch }) => epoch),
                  ),
                  () => 0,
                ),
              } satisfies RunStartReservation),
              next: {
                ...current,
                startingState: buildRunningState(current.state, item, { startedAtMs }),
              },
              persist: false,
            }
          },
        )
      },
    )

    const refreshRuntimeState = Effect.suspend(
      Effect.fn("AgentLoop.refreshRuntimeState")(function* () {
        if (!(yield* Ref.get(scope.startedRef))) return
        yield* persistRuntimeState(yield* currentLoopState)
      }),
    )

    const takeNextQueuedTurnFromState = Effect.fn("AgentLoop.takeNextQueuedTurnFromState")(
      function* (options: { readonly onlyIfIdle: boolean }) {
        const queuedCreatedAt = yield* DateTime.nowAsDate
        return yield* commitQueueTransaction("dequeued turn", (s) => {
          if (options.onlyIfIdle && s.state._tag !== "Idle") {
            return { value: Option.none(), next: s, persist: false }
          }
          const { queue, nextItem } = takeNextQueuedTurn(s.queue, queuedCreatedAt)
          return {
            value: nextItem,
            next: { ...s, queue },
            persist: queue !== s.queue,
          }
        })
      },
    )

    const clearInFlightTurn = Effect.fn("AgentLoop.clearInFlightTurn")(
      (messageId: QueuedTurnItem["message"]["id"]) =>
        commitQueueTransaction("cleared in-flight turn", (s) => {
          const queue = clearInFlightQueuedTurn(s.queue, messageId)
          return {
            value: void 0,
            next: { ...s, queue },
            persist: queue !== s.queue,
          }
        }),
    )

    const appendSteering = Effect.fn("AgentLoop.appendSteering")((item: QueuedTurnItem) =>
      commitQueueTransaction("queued steering", (s) => ({
        value: s.state,
        next: { ...s, queue: appendSteeringItem(s.queue, item) },
        persist: true,
      })),
    )

    const deliverableAtStep = (item: QueuedTurnItem) =>
      Predicate.isUndefined(item.agentOverride) && Predicate.isUndefined(item.runSpec)

    const takeSteeringForStep = commitQueueTransaction("delivered steering at step", (s) => {
      const delivered = s.queue.steering.filter(deliverableAtStep)
      if (delivered.length === 0) return { value: delivered, next: s, persist: false }
      const kept = s.queue.steering.filter((item) => !deliverableAtStep(item))
      return {
        value: delivered,
        next: { ...s, queue: { ...s.queue, steering: kept } },
        persist: true,
      }
    }).pipe(Effect.withSpan("AgentLoop.takeSteeringForStep"))

    const drainQueue = commitQueueTransaction("drained queue", (s) => ({
      value: queueSnapshotFromQueueState(s.queue),
      next: { ...s, queue: drainVisibleQueueItems(s.queue) },
      persist: true,
    })).pipe(Effect.withSpan("AgentLoop.drainQueue"))

    const removeFollowUp = Effect.fn("AgentLoop.removeFollowUp")(
      (messageId: QueuedTurnItem["message"]["id"]) =>
        commitQueueTransaction("removed queued follow-up", (s) => {
          const queue = removeQueuedFollowUp(s.queue, messageId)
          return {
            value: queue !== s.queue,
            next: { ...s, queue },
            persist: queue !== s.queue,
          }
        }),
    )

    const saveCheckpoint = (next: LoopState): Effect.Effect<void, AgentLoopError> =>
      persistRuntimeState(next).pipe(
        Effect.catchEager((error) =>
          Deferred.fail(scope.persistenceFailure, error).pipe(
            Effect.asVoid,
            Effect.andThen(Effect.fail(error)),
          ),
        ),
        Effect.withSpan("AgentLoop.durability.save"),
      )

    return {
      readState,
      stateChanges,
      runtimeState,
      queueSnapshot,
      currentLoopState,
      persistRuntimeState,
      refreshRuntimeState,
      setStartingState,
      reserveStartOrQueueFollowUp,
      reserveRunStartOrQueueFollowUp,
      takeNextQueuedTurnIfIdle: takeNextQueuedTurnFromState({ onlyIfIdle: true }),
      takeNextQueuedTurn: takeNextQueuedTurnFromState({ onlyIfIdle: false }),
      clearInFlightTurn,
      appendSteering,
      takeSteeringForStep,
      drainQueue,
      removeFollowUp,
      saveCheckpoint,
    }
  })
