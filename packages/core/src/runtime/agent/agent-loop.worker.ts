import { Cause, Clock, Context, Effect, Ref, TxQueue, type Semaphore } from "effect"
import { DEFAULT_AGENT_NAME, type AgentName as AgentNameType } from "../../domain/agent.js"
import { ErrorOccurred, type AgentEvent } from "../../domain/event.js"
import type { BranchId, InteractionRequestId, SessionId } from "../../domain/ids.js"
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

export type AgentLoopWorkerScopeService = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sideMutationSemaphore: Semaphore.Semaphore
  readonly turnWorkerQueue: TxQueue.TxQueue<RunningState>
  readonly activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  readonly interruptedRef: Ref.Ref<boolean>
  readonly currentLoopState: Effect.Effect<LoopState>
  readonly saveCheckpoint: (next: LoopState) => Effect.Effect<void, AgentLoopError>
  readonly takeNextQueuedTurn: Effect.Effect<QueuedTurnItem | undefined, AgentLoopError>
  readonly recordTurnFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
  readonly publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  readonly switchAgentOnState: (state: LoopState, next: AgentNameType) => Effect.Effect<LoopState>
}

export class AgentLoopWorkerScope extends Context.Service<
  AgentLoopWorkerScope,
  AgentLoopWorkerScopeService
>()("@gent/core/src/runtime/agent/agent-loop.worker/AgentLoopWorkerScope") {}

export const interruptActiveStream = Effect.fn("AgentLoop.interruptActiveStream")(function* (
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>,
) {
  const activeStream = yield* Ref.get(activeStreamRef)
  if (activeStream === undefined) return
  yield* signalActiveStreamInterrupt(activeStream)
})

const publishPhaseFailure = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  cause: Cause.Cause<unknown>
}) =>
  params
    .publishEvent(
      ErrorOccurred.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        error: Cause.pretty(params.cause),
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

export const makeAgentLoopWorker = <E, R>(
  runTurn: (state: RunningState) => Effect.Effect<TurnOutcome, E, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* AgentLoopWorkerScope

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
        if (nextItem !== undefined) {
          const startedAtMs = yield* Clock.currentTimeMillis
          const nextRunning = buildRunningState(
            { currentAgent: startState.currentAgent },
            nextItem,
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
        yield* publishPhaseFailure({
          publishEvent: scope.publishEvent,
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          cause,
        })
        const nextItem = yield* scope.takeNextQueuedTurn
        const current = yield* scope.currentLoopState
        yield* Ref.set(scope.interruptedRef, false)
        if (nextItem !== undefined) {
          const startedAtMs = yield* Clock.currentTimeMillis
          const nextRunning = buildRunningState(
            { currentAgent: current.currentAgent ?? startState.currentAgent },
            nextItem,
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

    const runTurnWorker = (startState: RunningState) =>
      scope.sideMutationSemaphore.withPermits(1)(
        runTurn(startState).pipe(
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
            onFailure: (cause) => failTurnWorker(startState, cause),
            onSuccess: (outcome) => finishTurnWorker(startState, outcome),
          }),
          Effect.catchCause((cause) =>
            scope.recordTurnFailure(cause).pipe(
              Effect.andThen(
                publishPhaseFailure({
                  publishEvent: scope.publishEvent,
                  sessionId: scope.sessionId,
                  branchId: scope.branchId,
                  cause,
                }),
              ),
              Effect.ignore,
            ),
          ),
          Effect.ignore,
        ),
      )

    const turnWorkerLoop = TxQueue.take(scope.turnWorkerQueue).pipe(
      Effect.flatMap(runTurnWorker),
      Effect.forever,
      Effect.ignore,
    )

    const interrupt: Effect.Effect<void, AgentLoopError> = Effect.gen(function* () {
      const snap = yield* scope.currentLoopState
      if (snap._tag === "Idle") return
      if (snap._tag === "Running") {
        yield* Ref.set(scope.interruptedRef, true)
        yield* interruptActiveStream(scope.activeStreamRef)
        return
      }
      yield* scope.sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* scope.currentLoopState
          if (state._tag !== "WaitingForInteraction") return
          yield* Ref.set(scope.interruptedRef, true)
          const resumed = buildRunningState(
            { currentAgent: state.currentAgent },
            {
              message: state.message,
              ...(state.agentOverride !== undefined ? { agentOverride: state.agentOverride } : {}),
              ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
              ...(state.interactive !== undefined ? { interactive: state.interactive } : {}),
            },
            { startedAtMs: state.startedAtMs },
          )
          yield* scope.saveCheckpoint(resumed)
          yield* enqueueTurnWorker(resumed)
        }),
      )
    }).pipe(Effect.withSpan("AgentLoop.interrupt"))

    const startTurn = Effect.fn("AgentLoop.startTurn")((item: QueuedTurnItem) =>
      scope.sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* scope.currentLoopState
          if (state._tag !== "Idle") return
          yield* Ref.set(scope.interruptedRef, false)
          const startedAtMs = yield* Clock.currentTimeMillis
          const next = buildRunningState(state, item, { startedAtMs })
          yield* scope.saveCheckpoint(next)
          yield* enqueueTurnWorker(next)
        }),
      ),
    )

    const switchAgent = Effect.fn("AgentLoop.switchAgent")((agent: AgentNameType) =>
      scope.sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* scope.currentLoopState
          const next = yield* scope.switchAgentOnState(state, agent)
          if (next === state) return
          yield* scope.saveCheckpoint(next)
        }),
      ),
    )

    const respondInteraction = Effect.fn("AgentLoop.respondInteraction")(
      (requestId: InteractionRequestId) =>
        scope.sideMutationSemaphore.withPermits(1)(
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
                ...(state.agentOverride !== undefined
                  ? { agentOverride: state.agentOverride }
                  : {}),
                ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
                ...(state.interactive !== undefined ? { interactive: state.interactive } : {}),
              },
              { startedAtMs: state.startedAtMs },
            )
            yield* scope.saveCheckpoint(resumed)
            yield* enqueueTurnWorker(resumed)
          }),
        ),
    )

    return {
      turnWorkerLoop,
      startTurn,
      interruptActiveStream: interruptActiveStream(scope.activeStreamRef),
      interrupt,
      switchAgent,
      respondInteraction,
      withSideMutation: <A, E, R2>(effect: Effect.Effect<A, E, R2>): Effect.Effect<A, E, R2> =>
        scope.sideMutationSemaphore.withPermits(1)(effect),
    }
  })
