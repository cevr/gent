import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
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
  takeNextQueuedTurn,
  type AgentLoopState,
  type LoopQueueState,
  type LoopState,
  type QueuedTurnItem,
  type RunningState,
  type SessionRuntimeState,
} from "./agent-loop.state.js"

const FOLLOW_UP_QUEUE_MAX = 10

export type AgentLoopQueueScopeService = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly loopRef: TxSubscriptionRef.TxSubscriptionRef<AgentLoopState>
  readonly queuePersistenceSemaphore: Semaphore.Semaphore
  readonly persistenceFailure: Deferred.Deferred<void, AgentLoopError>
  readonly startedRef: Ref.Ref<boolean>
}

export class AgentLoopQueueScope extends Context.Service<
  AgentLoopQueueScope,
  AgentLoopQueueScopeService
>()("@gent/core/src/runtime/agent/agent-loop.queue/AgentLoopQueueScope") {}

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
    options: { readonly coldQueueOnly: boolean },
  ) => Effect.Effect<RunningState | undefined, AgentLoopError>
  readonly reserveRunStartOrQueueFollowUp: (item: QueuedTurnItem) => Effect.Effect<
    | {
        readonly stateEpochBaseline: number
        readonly turnFailureBaseline: number
      }
    | undefined,
    AgentLoopError
  >
  readonly takeNextQueuedTurnIfIdle: Effect.Effect<QueuedTurnItem | undefined, AgentLoopError>
  readonly takeNextQueuedTurn: Effect.Effect<QueuedTurnItem | undefined, AgentLoopError>
  readonly clearInFlightTurn: (
    messageId: QueuedTurnItem["message"]["id"],
  ) => Effect.Effect<void, AgentLoopError>
  readonly appendSteering: (item: QueuedTurnItem) => Effect.Effect<LoopState, AgentLoopError>
  readonly drainQueue: Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly saveCheckpoint: (next: LoopState) => Effect.Effect<void, AgentLoopError>
}

const mergeConcurrentLoopMetadata = (
  base: AgentLoopState,
  current: AgentLoopState,
  next: AgentLoopState,
): AgentLoopState => ({
  ...next,
  turnFailure: current.turnFailure !== base.turnFailure ? current.turnFailure : next.turnFailure,
})

export const makeAgentLoopQueue: Effect.Effect<
  AgentLoopQueue,
  never,
  AgentLoopQueueScope | AgentLoopQueueStorage
> = Effect.gen(function* () {
  const scope = yield* AgentLoopQueueScope
  const queueStorage = yield* AgentLoopQueueStorage

  const persistCommittedQueue = (queue: LoopQueueState, operation: string) =>
    Effect.flatMap(Ref.get(scope.startedRef), (started) =>
      started
        ? queueStorage.putQueueState(scope.sessionId, scope.branchId, queue).pipe(
            Effect.mapError(
              (cause) =>
                new AgentLoopError({
                  message: `Failed to persist ${operation} for ${scope.sessionId}/${scope.branchId}`,
                  cause,
                }),
            ),
          )
        : Effect.void,
    )

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
      const committed = next.persist
        ? {
            ...next.next,
            stateEpoch: next.next.stateEpoch + 1,
          }
        : next.next
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
              TxSubscriptionRef.update(scope.loopRef, (current) => ({
                ...current,
                state,
                queue: current.queue,
                stateEpoch: current.stateEpoch + 1,
                startingState: undefined,
              })),
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

  const reserveStartOrQueueFollowUp = Effect.fn("AgentLoop.reserveStartOrQueueFollowUp")(function* (
    item: QueuedTurnItem,
    options: { readonly coldQueueOnly: boolean },
  ) {
    const startedAtMs = yield* Clock.currentTimeMillis
    return yield* commitQueueTransaction<RunningState | undefined | AgentLoopError>(
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
        if (options.coldQueueOnly) {
          return {
            value: undefined,
            next: { ...current, queue: nextQueue },
            persist: true,
          }
        }

        if (current.startingState !== undefined) {
          return {
            value: undefined,
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
            value: undefined,
            next: { ...current, queue: nextQueue },
            persist: true,
          }
        }

        const reservedRunningState = buildRunningState(current.state, item, { startedAtMs })
        return {
          value: reservedRunningState,
          next: { ...current, startingState: reservedRunningState },
          persist: false,
        }
      },
    ).pipe(
      Effect.flatMap(
        (value): Effect.Effect<RunningState | undefined, AgentLoopError> =>
          Schema.is(AgentLoopError)(value) ? Effect.fail(value) : Effect.succeed(value),
      ),
    )
  })

  const reserveRunStartOrQueueFollowUp = Effect.fn("AgentLoop.reserveRunStartOrQueueFollowUp")(
    function* (item: QueuedTurnItem) {
      const startedAtMs = yield* Clock.currentTimeMillis
      return yield* commitQueueTransaction("run start reservation", (current) => {
        if (current.state._tag !== "Idle" || current.startingState !== undefined) {
          const state = current.startingState ?? current.state
          return {
            value: undefined,
            next: { ...current, state, queue: appendFollowUpQueueState(current.queue, item) },
            persist: true,
          }
        }

        return {
          value: {
            stateEpochBaseline: current.stateEpoch,
            turnFailureBaseline: current.turnFailure?.epoch ?? 0,
          },
          next: {
            ...current,
            startingState: buildRunningState(current.state, item, { startedAtMs }),
          },
          persist: false,
        }
      })
    },
  )

  const refreshRuntimeState = Effect.gen(function* () {
    if (!(yield* Ref.get(scope.startedRef))) return
    yield* persistRuntimeState(yield* currentLoopState)
  }).pipe(Effect.withSpan("AgentLoop.refreshRuntimeState"))

  const takeNextQueuedTurnFromState = Effect.fn("AgentLoop.takeNextQueuedTurnFromState")(
    function* (options: { readonly onlyIfIdle: boolean }) {
      const queuedCreatedAt = yield* DateTime.nowAsDate
      return yield* commitQueueTransaction("dequeued turn", (s) => {
        if (options.onlyIfIdle && s.state._tag !== "Idle") {
          return { value: undefined, next: s, persist: false }
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
          value: undefined,
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

  const drainQueue = commitQueueTransaction("drained queue", (s) => ({
    value: queueSnapshotFromQueueState(s.queue),
    next: { ...s, queue: drainVisibleQueueItems(s.queue) },
    persist: true,
  })).pipe(Effect.withSpan("AgentLoop.drainQueue"))

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
    drainQueue,
    saveCheckpoint,
  }
})
