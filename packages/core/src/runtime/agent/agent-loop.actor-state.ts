/**
 * When a turn is finished, told from the outside.
 *
 * A turn is over when the loop no longer holds its message: not starting it,
 * not running it, not waiting on it, and not keeping it queued. That is read
 * off the loop's own state, so no event subscription can miss it. Failure is
 * a monotonic counter (`turnFailure.epoch`); a caller records where it stood
 * before starting the turn (`turnFailureBaseline`) and a later mark is this
 * turn's failure.
 *
 * @module
 */

import { Effect, Option, Predicate, Schema, Stream } from "effect"
import type { AgentLoopBehavior } from "./agent-loop.behavior.js"
import {
  AgentLoopError,
  turnFailureEpoch,
  type AgentLoopState,
  type LoopState,
  type QueuedTurnItem,
} from "./agent-loop.state.js"

type MessageId = QueuedTurnItem["message"]["id"]

const stateHoldsMessage = (state: LoopState, messageId: MessageId) =>
  state._tag !== "Idle" && state.message.id === messageId

/** The loop still owns this message: starting, running, waiting, or queued. */
const holdsMessage = (s: AgentLoopState, messageId: MessageId): boolean => {
  const item = (queued: QueuedTurnItem) => queued.message.id === messageId
  return (
    stateHoldsMessage(s.state, messageId) ||
    (Predicate.isNotUndefined(s.startingState) && stateHoldsMessage(s.startingState, messageId)) ||
    (Predicate.isNotUndefined(s.queue.inFlight) && item(s.queue.inFlight)) ||
    s.queue.followUp.some(item) ||
    s.queue.steering.some(item)
  )
}

const waitForMessageReleased = (
  behavior: AgentLoopBehavior,
  messageId: MessageId,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (!holdsMessage(current, messageId)) return
    yield* behavior.stateChanges.pipe(
      Stream.filter((state) => !holdsMessage(state, messageId)),
      Stream.runHead,
    )
  })

const failTurnFailureState = (failure: NonNullable<AgentLoopState["turnFailure"]>) => {
  if (Schema.is(AgentLoopError)(failure.error)) return Effect.fail(failure.error)
  return Effect.fail(
    new AgentLoopError({ message: "Agent loop turn failed", cause: failure.error }),
  )
}

const waitForTurnFailureAfterEpoch = (
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

const failIfTurnFailedAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (Predicate.isNotUndefined(current.turnFailure) && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
  })

/** Record the failure mark to wait from. Take this *before* starting the turn. */
export const turnFailureBaseline = (behavior: AgentLoopBehavior): Effect.Effect<number> =>
  Effect.map(behavior.readState, turnFailureEpoch)

/**
 * Wait until the loop has released `messageId`, started after `baseline`.
 *
 * It ends three ways, and all three end the wait: the loop lets the message
 * go (the turn ran, or a batch absorbed it), the turn fails, or persistence
 * fails. The last two fail the effect.
 */
export const awaitTurnCompletion = (
  behavior: AgentLoopBehavior,
  baseline: number,
  messageId: MessageId,
): Effect.Effect<void, AgentLoopError> =>
  Effect.raceFirst(
    Effect.raceFirst(
      waitForMessageReleased(behavior, messageId),
      waitForTurnFailureAfterEpoch(behavior, baseline),
    ),
    behavior.persistenceFailure,
  ).pipe(
    // Release wins the race even when the turn failed on its way there,
    // so the failure is checked once more after the race settles.
    Effect.andThen(failIfTurnFailedAfterEpoch(behavior, baseline)),
  )
