import { Effect, Option, Predicate, Schema, Stream } from "effect"
import type { AgentName, RunSpec } from "../../domain/agent.js"
import type { AgentLoopBehavior } from "./agent-loop.behavior.js"
import { AgentLoopError, type AgentLoopState, type QueuedTurnItem } from "./agent-loop.state.js"
import type { MessageType } from "./agent-loop.protocol.js"

export const buildQueuedTurnItem = (operation: {
  readonly message: MessageType
  readonly agentOverride?: AgentName
  readonly runSpec?: RunSpec
  readonly interactive?: boolean
}): QueuedTurnItem => ({
  message: operation.message,
  agentOverride: operation.agentOverride,
  runSpec: operation.runSpec,
  interactive: operation.interactive,
})

export const waitForIdleAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (current.stateEpoch > baseline && current.state._tag === "Idle") return
    yield* behavior.stateChanges.pipe(
      Stream.filter((state) => state.stateEpoch > baseline && state.state._tag === "Idle"),
      Stream.runHead,
    )
  })

const failTurnFailureState = (failure: NonNullable<AgentLoopState["turnFailure"]>) => {
  if (Schema.is(AgentLoopError)(failure.error)) return Effect.fail(failure.error)
  return Effect.fail(
    new AgentLoopError({ message: "Agent loop turn failed", cause: failure.error }),
  )
}

export const waitForTurnFailureAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (Predicate.isNotUndefined(current.turnFailure) && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
    const hasNewTurnFailure = (
      state: AgentLoopState,
    ): state is AgentLoopState & {
      readonly turnFailure: NonNullable<AgentLoopState["turnFailure"]>
    } => Predicate.isNotUndefined(state.turnFailure) && state.turnFailure.epoch > baseline
    const next = yield* behavior.stateChanges.pipe(Stream.filter(hasNewTurnFailure), Stream.runHead)
    if (Option.isSome(next)) return yield* failTurnFailureState(next.value.turnFailure)
    return yield* new AgentLoopError({
      message: "Agent loop turn failure stream ended",
    })
  })

export const failIfTurnFailedAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (Predicate.isNotUndefined(current.turnFailure) && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
  })
