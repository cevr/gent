import { Cause, Clock, Effect, Option, Predicate, Ref, TxQueue, type Semaphore } from "effect"
import { DEFAULT_AGENT_NAME, type AgentName as AgentNameType } from "../../domain/agent.js"
import { ErrorOccurred, type AgentEvent } from "../../domain/event.js"
import type { BranchId, InteractionRequestId, MessageId, SessionId } from "../../domain/ids.js"
import {
  buildIdleState,
  buildRunningState,
  toWaitingForInteractionState,
  type AgentLoopError,
  type LoopState,
  type QueuedTurnItem,
  type RunningState,
} from "./agent-loop.state.js"
import { signalActiveStreamInterrupt, type ActiveStreamHandle } from "./turn-response.js"
import type { TurnOutcome } from "./agent-loop.turn-execution.js"
import { turnBoundary, withWideEvent } from "../wide-event-boundary.js"

export type AgentLoopWorkerContext<E = never, R = never> = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sideMutationSemaphore: Semaphore.Semaphore
  readonly interruptSemaphore: Semaphore.Semaphore
  readonly turnWorkerQueue: TxQueue.TxQueue<RunningState>
  readonly activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>
  readonly interruptedRef: Ref.Ref<boolean>
  readonly interruptCell: Effect.Effect<void>
  readonly currentLoopState: Effect.Effect<LoopState>
  readonly saveCheckpoint: (next: LoopState) => Effect.Effect<void, AgentLoopError>
  readonly takeNextQueuedTurn: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  /** True when the message was the in-flight admission. */
  readonly clearInFlightTurn: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  readonly admissionGateRef: Ref.Ref<AdmissionGate>
  readonly recordTurnFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
  readonly publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  readonly runTurn: (state: RunningState) => Effect.Effect<TurnOutcome, AgentLoopError | E, R>
  readonly switchAgentOnState: (state: LoopState, next: AgentNameType) => Effect.Effect<LoopState>
}

/**
 * Settles the race between a worker starting an admitted turn and a caller
 * withdrawing it. `started` names the turn the worker claimed; `withdrawn`
 * names an admission the worker must skip. One `Ref.modify` decides each side.
 */
export interface AdmissionGate {
  readonly started: Option.Option<MessageId>
  readonly withdrawn: Option.Option<MessageId>
}

export const emptyAdmissionGate: AdmissionGate = {
  started: Option.none(),
  withdrawn: Option.none(),
}

const names = (id: Option.Option<MessageId>, messageId: MessageId) =>
  Option.isSome(id) && id.value === messageId

export const interruptActiveStream = Effect.fn("AgentLoop.interruptActiveStream")(function* (
  activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>,
) {
  const activeStream = yield* Ref.get(activeStreamRef)
  if (Option.isNone(activeStream)) return
  yield* signalActiveStreamInterrupt(activeStream.value)
})

export const makeAgentLoopWorker = <E, R>(scope: AgentLoopWorkerContext<E, R>) => {
  const publishPhaseFailure = (cause: Cause.Cause<unknown>) =>
    scope
      .publishEvent(
        ErrorOccurred.make({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          error: Cause.pretty(cause),
        }),
      )
      .pipe(
        Effect.catchEager((error) =>
          Effect.logWarning("failed to publish ErrorOccurred").pipe(
            Effect.annotateLogs({ error: String(error) }),
          ),
        ),
        Effect.asVoid,
      )

  const enqueueTurnWorker = (state: RunningState): Effect.Effect<void> =>
    TxQueue.offer(scope.turnWorkerQueue, state).pipe(Effect.asVoid)

  const finishTurnWorker = (
    startState: RunningState,
    outcome: TurnOutcome,
  ): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      if (outcome._tag === "InteractionRequested") {
        const next = toWaitingForInteractionState({
          state: startState,
          currentTurnAgent: outcome.currentTurnAgent,
          pendingRequestId: outcome.pendingRequestId,
          pendingToolCallId: outcome.pendingToolCallId,
        })
        yield* scope.saveCheckpoint(next)
        return
      }

      const nextItem = yield* scope.takeNextQueuedTurn
      yield* Ref.set(scope.interruptedRef, false)
      if (Option.isSome(nextItem)) {
        const startedAtMs = yield* Clock.currentTimeMillis
        const nextRunning = buildRunningState(
          { currentAgent: startState.currentAgent },
          nextItem.value,
          {
            startedAtMs,
          },
        )
        yield* scope.saveCheckpoint(nextRunning)
        yield* enqueueTurnWorker(nextRunning)
        return
      }
      yield* scope.saveCheckpoint(buildIdleState({ currentAgent: startState.currentAgent }))
    })

  const failTurnWorker = (
    startState: RunningState,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      yield* scope.recordTurnFailure(cause)
      yield* publishPhaseFailure(cause)
      const nextItem = yield* scope.takeNextQueuedTurn
      const current = yield* scope.currentLoopState
      yield* Ref.set(scope.interruptedRef, false)
      if (Option.isSome(nextItem)) {
        const startedAtMs = yield* Clock.currentTimeMillis
        const nextRunning = buildRunningState(
          { currentAgent: current.currentAgent ?? startState.currentAgent },
          nextItem.value,
          { startedAtMs },
        )
        yield* scope.saveCheckpoint(nextRunning)
        yield* enqueueTurnWorker(nextRunning)
        return
      }
      yield* scope.saveCheckpoint(
        buildIdleState({ currentAgent: current.currentAgent ?? startState.currentAgent }),
      )
    })

  /** Claims the admission for this worker; false when it was withdrawn before the claim. */
  const claimAdmission = (messageId: MessageId): Effect.Effect<boolean> =>
    Ref.modify(scope.admissionGateRef, (gate): [boolean, AdmissionGate] => {
      if (names(gate.withdrawn, messageId)) return [false, { ...gate, withdrawn: Option.none() }]
      return [true, { ...gate, started: Option.some(messageId) }]
    })

  const releaseAdmission = Ref.update(scope.admissionGateRef, (gate): AdmissionGate => ({
    ...gate,
    started: Option.none(),
  }))

  const runTurnWorker = (startState: RunningState) =>
    Effect.gen(function* () {
      // A withdrawn admission (see `withdrawAdmittedTurn`) leaves its entry in
      // the worker queue; the gate decides whether this entry still runs.
      if (!(yield* claimAdmission(startState.message.id))) return
      yield* scope.runTurn(startState).pipe(
        Effect.annotateLogs({ sessionId: scope.sessionId, branchId: scope.branchId }),
        Effect.withSpan("AgentLoop.turn"),
        withWideEvent(
          turnBoundary(
            scope.sessionId,
            scope.branchId,
            startState.currentAgent ?? DEFAULT_AGENT_NAME,
          ),
        ),
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            failTurnWorker(startState, cause).pipe(scope.interruptSemaphore.withPermits(1)),
          onSuccess: (outcome) =>
            finishTurnWorker(startState, outcome).pipe(scope.interruptSemaphore.withPermits(1)),
        }),
        Effect.catchCause((cause) =>
          scope
            .recordTurnFailure(cause)
            .pipe(Effect.andThen(publishPhaseFailure(cause)), Effect.ignore),
        ),
        Effect.ignore,
        Effect.ensuring(releaseAdmission),
      )
    }).pipe(scope.sideMutationSemaphore.withPermits(1))

  /**
   * Drops a turn that was admitted as the next run but has not started.
   * Callers usually hold the side-mutation permit already (extension requests
   * and hooks), so this takes none; the admission gate and the in-flight
   * marker together prove the turn is only queued. The next queued item (if
   * any) takes its place.
   */
  const withdrawAdmittedTurn = Effect.fn("AgentLoop.withdrawAdmittedTurn")((messageId: MessageId) =>
    Effect.gen(function* () {
      const state = yield* scope.currentLoopState
      if (state._tag !== "Running" || state.message.id !== messageId) return false
      const won = yield* Ref.modify(scope.admissionGateRef, (gate): [boolean, AdmissionGate] => {
        if (names(gate.started, messageId)) return [false, gate]
        return [true, { ...gate, withdrawn: Option.some(messageId) }]
      })
      if (!won) return false
      // A resumed interaction turn is Running without an in-flight marker: it already started.
      if (!(yield* scope.clearInFlightTurn(messageId))) {
        yield* Ref.update(scope.admissionGateRef, (gate) => ({ ...gate, withdrawn: Option.none() }))
        return false
      }
      const nextItem = yield* scope.takeNextQueuedTurn
      if (Option.isSome(nextItem)) {
        const startedAtMs = yield* Clock.currentTimeMillis
        const nextRunning = buildRunningState(
          { currentAgent: state.currentAgent },
          nextItem.value,
          { startedAtMs },
        )
        yield* scope.saveCheckpoint(nextRunning)
        yield* enqueueTurnWorker(nextRunning)
        return true
      }
      yield* scope.saveCheckpoint(buildIdleState({ currentAgent: state.currentAgent }))
      return true
    }),
  )

  const turnWorkerLoop = TxQueue.take(scope.turnWorkerQueue).pipe(
    Effect.flatMap(runTurnWorker),
    Effect.forever,
    Effect.ignore,
  )

  const interrupt = Effect.fn("AgentLoop.interrupt")(function* (messageId?: MessageId) {
    const waiting = yield* Effect.gen(function* () {
      const snap = yield* scope.currentLoopState
      if (snap._tag === "Idle") return false
      if (Predicate.isNotUndefined(messageId) && snap.message.id !== messageId) return false
      if (snap._tag === "WaitingForInteraction") return true
      yield* Ref.set(scope.interruptedRef, true)
      yield* interruptActiveStream(scope.activeStreamRef)
      yield* scope.interruptCell
      return false
    }).pipe(scope.interruptSemaphore.withPermits(1))
    if (!waiting) return
    yield* Effect.gen(function* () {
      const state = yield* scope.currentLoopState
      if (state._tag !== "WaitingForInteraction") return
      if (Predicate.isNotUndefined(messageId) && state.message.id !== messageId) return
      yield* Ref.set(scope.interruptedRef, true)
      const resumed = buildRunningState(
        { currentAgent: state.currentAgent },
        {
          message: state.message,
          agentOverride: state.agentOverride,
          runSpec: state.runSpec,
          interactive: state.interactive,
        },
        { startedAtMs: state.startedAtMs },
      )
      yield* scope.saveCheckpoint(resumed)
      yield* enqueueTurnWorker(resumed)
    }).pipe(scope.sideMutationSemaphore.withPermits(1))
  })

  const startTurn = Effect.fn("AgentLoop.startTurn")((item: QueuedTurnItem) =>
    Effect.gen(function* () {
      const state = yield* scope.currentLoopState
      if (state._tag !== "Idle") return
      yield* Ref.set(scope.interruptedRef, false)
      const startedAtMs = yield* Clock.currentTimeMillis
      const next = buildRunningState(state, item, { startedAtMs })
      yield* scope.saveCheckpoint(next)
      yield* enqueueTurnWorker(next)
    }).pipe(scope.sideMutationSemaphore.withPermits(1)),
  )

  const switchAgent = Effect.fn("AgentLoop.switchAgent")((agent: AgentNameType) =>
    Effect.gen(function* () {
      const state = yield* scope.currentLoopState
      const next = yield* scope.switchAgentOnState(state, agent)
      if (next === state) return
      yield* scope.saveCheckpoint(next)
    }).pipe(scope.sideMutationSemaphore.withPermits(1)),
  )

  const respondInteraction = Effect.fn("AgentLoop.respondInteraction")(
    (requestId: InteractionRequestId) =>
      Effect.gen(function* () {
        const state = yield* scope.currentLoopState
        if (state._tag !== "WaitingForInteraction") return
        if (requestId !== state.pendingRequestId) {
          yield* Effect.logWarning(
            "Ignoring stale interaction response for non-pending request",
          ).pipe(
            Effect.annotateLogs({
              sessionId: state.message.sessionId,
              branchId: state.message.branchId,
              expectedRequestId: state.pendingRequestId,
              actualRequestId: requestId,
            }),
          )
          return
        }
        yield* Ref.set(scope.interruptedRef, false)
        const resumed = buildRunningState(
          { currentAgent: state.currentAgent },
          {
            message: state.message,
            agentOverride: state.agentOverride,
            runSpec: state.runSpec,
            interactive: state.interactive,
          },
          { startedAtMs: state.startedAtMs },
        )
        yield* scope.saveCheckpoint(resumed)
        yield* enqueueTurnWorker(resumed)
      }).pipe(scope.sideMutationSemaphore.withPermits(1)),
  )

  return {
    turnWorkerLoop,
    startTurn,
    interruptActiveStream: interruptActiveStream(scope.activeStreamRef),
    interrupt,
    switchAgent,
    respondInteraction,
    withdrawAdmittedTurn,
    withSideMutation: <A, E, R2>(effect: Effect.Effect<A, E, R2>): Effect.Effect<A, E, R2> =>
      effect.pipe(scope.sideMutationSemaphore.withPermits(1)),
  }
}
