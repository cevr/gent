/**
 * `/goal` keeps a durable per-branch objective and re-prompts the loop after
 * each ordinary turn until the goal completes or its token budget runs out.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { BranchId } from "@gent/core/extensions/api"
import { e2ePreset } from "../helpers/test-preset"
import {
  GOAL_CONTEXT_MESSAGE_TYPE,
  GOAL_EXTENSION_ID,
  type GoalState,
} from "../../src/goal/index.js"
import { GoalSnapshot, remainingTokens } from "../../src/goal/goal-protocol.js"
import { continuationPrompt, formatGoalUsage } from "../../src/goal/goal-prompts.js"

const sampleGoal: GoalState = {
  goalId: "g1",
  branchId: BranchId.make("b1"),
  objective: "Ship <it> & test",
  status: "active",
  tokenBudget: 100,
  tokensUsed: 40,
  timeUsedMs: 2_500,
  continuationsUsed: 2,
  createdAt: 0,
  updatedAt: 0,
}

describe("goals", () => {
  it.live("remaining budget is absent for unbounded goals and never negative", () =>
    Effect.sync(() => {
      expect(remainingTokens(sampleGoal)).toEqual(Option.some(60))
      expect(remainingTokens({ ...sampleGoal, tokensUsed: 500 })).toEqual(Option.some(0))
      const { tokenBudget: _budget, ...unbounded } = sampleGoal
      expect(remainingTokens(unbounded)).toEqual(Option.none())
    }),
  )

  it.live("the continuation prompt escapes the objective and reports usage", () =>
    Effect.sync(() => {
      const prompt = continuationPrompt(sampleGoal)
      expect(prompt).toContain("Ship &lt;it&gt; &amp; test")
      expect(prompt).toContain("remaining tokens: 60")
      expect(formatGoalUsage(sampleGoal)).toBe(
        "active · 2 continuations · 40 tokens · 3s · 60 remaining of 100",
      )
    }),
  )

  it.live(
    "a budgeted goal continues after each turn until the budget is spent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Each text turn costs 10 input tokens plus a few output tokens. A budget
          // of 15 allows one continuation; the second turn exhausts it.
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("first pass"),
            textStep("second pass"),
            textStep("budget report"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const command = (input: string) =>
            client.extension.request({
              sessionId,
              branchId,
              extensionId: GOAL_EXTENSION_ID,
              capabilityId: "goal-command",
              input,
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

          yield* command("--budget 15 Write the pelican poem")
          const created = yield* readGoal()
          expect(Option.isSome(created)).toBe(true)
          if (Option.isSome(created)) {
            expect(created.value.objective).toBe("Write the pelican poem")
            expect(created.value.status).toBe("active")
            expect(created.value.tokenBudget).toBe(15)
          }

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle" && current.messages.length >= 6,
            8_000,
            "goal turns settle",
          )
          const goalMessages = snapshot.messages.filter(
            (message) => message.metadata?.customType === GOAL_CONTEXT_MESSAGE_TYPE,
          )
          expect(goalMessages.length).toBe(3)
          expect(
            goalMessages[2]?.parts.some(
              (part) => part.type === "text" && part.text.includes("reached its token budget"),
            ),
          ).toBe(true)

          const limited = yield* readGoal()
          expect(Option.isSome(limited)).toBe(true)
          if (Option.isSome(limited)) {
            expect(limited.value.status).toBe("budget_limited")
            expect(limited.value.continuationsUsed).toBe(1)
            expect(limited.value.tokensUsed).toBeGreaterThanOrEqual(15)
          }
          expect(yield* controls.callCount).toBe(3)

          // A second goal is refused while one is pending; clear ends it.
          const refused = yield* Effect.exit(command("Another objective"))
          expect(Exit.isFailure(refused)).toBe(true)
          if (Exit.isFailure(refused)) {
            expect(Cause.pretty(refused.cause)).toContain("already budget_limited")
          }
          yield* command("clear")
          const cleared = yield* readGoal()
          expect(Option.map(cleared, (goal) => goal.status)).toEqual(Option.some("complete"))
          yield* controls.assertDone
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
