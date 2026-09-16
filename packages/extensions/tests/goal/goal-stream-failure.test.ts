/**
 * A goal must not be driven on by a turn that never answered.
 *
 * `continueGoal` reads `turnAfter`. Before it read `streamFailed`, a turn that
 * died on a broken provider stream still charged the budget and queued another
 * continuation prompt, so the goal spent itself against an answer that never
 * arrived and the queued prompt woke the branch for one more turn.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Ref, Schema, Stream } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { LanguageModelLayers, textDeltaPart } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { e2ePreset } from "../helpers/test-preset"
import { GOAL_CONTEXT_MESSAGE_TYPE, GOAL_EXTENSION_ID } from "../../src/goal/index.js"
import { GoalSnapshot } from "../../src/goal/goal-protocol.js"

describe("goal stream failure", () => {
  it.scopedLive(
    "a goal pauses when the stream keeps breaking, and queues nothing more",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        // Writes something, then breaks, on every call. The driver retries a
        // break before any output; the loop spends its two continuations on a
        // break after partial output. The third failure ends the turn.
        const providerLayer = LanguageModelLayers.testStream(() =>
          Effect.gen(function* () {
            const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
            return Stream.concat(
              Stream.fromIterable([textDeltaPart(`part ${call}`)]),
              Stream.fail(
                AiError.make({
                  module: "Test",
                  method: "streamText",
                  reason: new AiError.UnknownError({ description: "connection reset" }),
                }),
              ),
            )
          }),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
        })
        const readGoal = () =>
          client.extension
            .request({
              sessionId,
              branchId,
              extensionId: GOAL_EXTENSION_ID,
              capabilityId: "goal.get",
              input: {},
            })
            .pipe(
              Effect.map((snapshot) =>
                Option.fromUndefinedOr(Schema.decodeUnknownSync(GoalSnapshot)(snapshot).goal),
              ),
            )

        yield* client.extension.request({
          sessionId,
          branchId,
          extensionId: GOAL_EXTENSION_ID,
          capabilityId: "goal-command",
          input: "Write the pelican poem",
        })
        const created = yield* readGoal()
        expect(Option.map(created, (goal) => goal.status)).toEqual(Option.some("active"))

        const paused = yield* waitFor(
          readGoal(),
          (goal) =>
            Option.contains(
              Option.map(goal, (value) => value.status),
              "paused",
            ),
          10_000,
          "goal pauses on the stream failure",
        )
        expect(Option.map(paused, (goal) => goal.continuationsUsed)).toEqual(Option.some(0))

        // Creating the goal queues the first continuation, which starts the turn
        // that then fails. The failed turn must not queue a second one: that is
        // the prompt that would wake the branch and spend the goal again.
        const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
        expect(snapshot.runtime._tag).toBe("Idle")
        const goalMessages = snapshot.messages.filter(
          (message) => message.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE,
        )
        expect(goalMessages.length).toBe(1)
        // Two continuations inside the one turn, then the failure. No fourth call.
        expect(yield* Ref.get(calls)).toBe(3)
      }).pipe(Effect.timeout("14 seconds")),
    18_000,
  )
})
