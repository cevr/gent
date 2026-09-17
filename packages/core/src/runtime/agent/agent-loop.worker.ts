import { Cause, Clock, Effect, Option, Predicate, Ref, TxQueue, type Semaphore } from "effect"
import { DEFAULT_AGENT_NAME } from "../../domain/agent.js"
import { ErrorOccurred, type AgentEvent } from "../../domain/event.js"
import { causeChainMessage } from "../../domain/guards.js"
import type { BranchId, InteractionRequestId, MessageId, SessionId } from "../../domain/ids.js"
import {
  buildIdleState,
  buildRunningState,
  toWaitingForInteractionState,
  type AgentLoopError,
  type RunningState,
  type WaitingForInteractionState,
} from "./agent-loop.state.js"
import type { LoopInbox } from "./loop-inbox.js"
import type { QueuedTurnItem } from "../../domain/queue.js"
import { signalActiveStreamInterrupt, type ActiveStreamHandle } from "./turn-response.js"
import type { TurnOutcome } from "./agent-loop.turn-execution.js"
import type { TurnInterruption } from "./turn-interruption.js"
import { turnBoundary, withWideEvent } from "../wide-event-boundary.js"

type AgentLoopWorkerContext<E = never, R = never> = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sideMutationSemaphore: Semaphore.Semaphore
  readonly interruptSemaphore: Semaphore.Semaphore
  readonly turnWorkerQueue: TxQueue.TxQueue<RunningState>
  readonly activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>
  readonly turnInterruption: TurnInterruption
  /** Cancel whatever tool work this loop has in flight. Idempotent. */
  readonly interruptToolWork: Effect.Effect<void>
  readonly inbox: LoopInbox
  readonly admissionGateRef: Ref.Ref<AdmissionGate>
  readonly recordTurnFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
  readonly publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  readonly runTurn: (state: RunningState) => Effect.Effect<TurnOutcome, AgentLoopError | E, R>
}

/**
 * Settles the race between a worker starting an admitted turn and a caller
 * withdrawing it. `started` names the turn the worker claimed; `withdrawn`
 * names an admission the worker must skip. One `Ref.modify` decides each side.
 */
interface AdmissionGate {
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
  // The event is what the transcript prints, so it carries the messages down
  // the cause chain. The frames go to the log: one storage failure printed
  // 150 rows of them into a live session.
  const publishPhaseFailure = (cause: Cause.Cause<unknown>) =>
    Effect.logWarning("turn.phase-failed")
      .pipe(
        Effect.annotateLogs({ error: Cause.pretty(cause) }),
        Effect.andThen(
          scope.publishEvent(
            ErrorOccurred.make({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              error: causeChainMessage(Cause.squash(cause)),
            }),
          ),
        ),
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

  /** Start the next admitted turn on this loop, or park it idle. */
  const advanceOrIdle = (
    nextItem: Option.Option<QueuedTurnItem>,
  ): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      if (Option.isNone(nextItem)) return yield* scope.inbox.moveToPhase(buildIdleState())
      const startedAtMs = yield* Clock.currentTimeMillis
      const nextRunning = buildRunningState(nextItem.value, { startedAtMs })
      yield* scope.inbox.moveToPhase(nextRunning)
      yield* enqueueTurnWorker(nextRunning)
    })

  /** Resume a turn parked on an interaction under its original admission. */
  const resumeWaiting = (state: WaitingForInteractionState): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      const resumed = buildRunningState(state, { startedAtMs: state.startedAtMs })
      yield* scope.inbox.moveToPhase(resumed)
      yield* enqueueTurnWorker(resumed)
    })

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
        yield* scope.inbox.moveToPhase(next)
        return
      }

      const nextItem = yield* scope.inbox.take
      yield* scope.turnInterruption.beginTurn
      yield* advanceOrIdle(nextItem)
    })

  const failTurnWorker = (cause: Cause.Cause<unknown>): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      yield* scope.recordTurnFailure(cause)
      yield* publishPhaseFailure(cause)
      const nextItem = yield* scope.inbox.take
      yield* scope.turnInterruption.beginTurn
      yield* advanceOrIdle(nextItem)
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
            startState.agentOverride ?? DEFAULT_AGENT_NAME,
          ),
        ),
        Effect.matchCauseEffect({
          onFailure: (cause) => failTurnWorker(cause).pipe(scope.interruptSemaphore.withPermits(1)),
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
      const state = yield* scope.inbox.phase
      if (state._tag !== "Running" || state.message.id !== messageId) return false
      // The gate is the only serialization point: a second concurrent withdrawal
      // of the same admission loses here, so it can never clear the marker that
      // keeps the worker from running the turn.
      const won = yield* Ref.modify(scope.admissionGateRef, (gate): [boolean, AdmissionGate] => {
        if (names(gate.started, messageId) || names(gate.withdrawn, messageId)) return [false, gate]
        return [true, { ...gate, withdrawn: Option.some(messageId) }]
      })
      if (!won) return false
      // A resumed interaction turn is Running without an in-flight marker: it already started.
      if (!(yield* scope.inbox.settle(messageId))) {
        yield* Ref.update(scope.admissionGateRef, (gate) => ({ ...gate, withdrawn: Option.none() }))
        return false
      }
      yield* advanceOrIdle(yield* scope.inbox.take)
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
      const snap = yield* scope.inbox.phase
      if (snap._tag === "Idle") return false
      if (Predicate.isNotUndefined(messageId) && snap.message.id !== messageId) return false
      if (snap._tag === "WaitingForInteraction") return true
      yield* scope.turnInterruption.interrupt
      yield* interruptActiveStream(scope.activeStreamRef)
      yield* scope.interruptToolWork
      return false
    }).pipe(scope.interruptSemaphore.withPermits(1))
    if (!waiting) return
    yield* Effect.gen(function* () {
      const state = yield* scope.inbox.phase
      if (state._tag !== "WaitingForInteraction") return
      if (Predicate.isNotUndefined(messageId) && state.message.id !== messageId) return
      yield* scope.turnInterruption.interrupt
      yield* resumeWaiting(state)
    }).pipe(scope.sideMutationSemaphore.withPermits(1))
  })

  const startTurn = Effect.fn("AgentLoop.startTurn")((item: QueuedTurnItem) =>
    Effect.gen(function* () {
      const state = yield* scope.inbox.phase
      if (state._tag !== "Idle") return
      yield* scope.turnInterruption.beginTurn
      yield* advanceOrIdle(Option.some(item))
    }).pipe(scope.sideMutationSemaphore.withPermits(1)),
  )

  const respondInteraction = Effect.fn("AgentLoop.respondInteraction")(
    (requestId: InteractionRequestId) =>
      Effect.gen(function* () {
        const state = yield* scope.inbox.phase
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
        yield* scope.turnInterruption.beginTurn
        yield* resumeWaiting(state)
      }).pipe(scope.sideMutationSemaphore.withPermits(1)),
  )

  return {
    turnWorkerLoop,
    startTurn,
    interruptActiveStream: interruptActiveStream(scope.activeStreamRef),
    interrupt,
    respondInteraction,
    withdrawAdmittedTurn,
    withSideMutation: <A, E, R2>(effect: Effect.Effect<A, E, R2>): Effect.Effect<A, E, R2> =>
      effect.pipe(scope.sideMutationSemaphore.withPermits(1)),
  }
}
