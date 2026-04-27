import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { PromptTool } from "@gent/extensions/interaction-tools/prompt"
import { testToolContext } from "@gent/core/test-utils/extension-harness"

const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>

describe("Prompt Tool", () => {
  it.live("review mode: writes content and returns decision", () => {
    const ctx = testToolContext({
      interaction: {
        approve: () => Effect.die("interaction.approve not wired"),
        present: () => Effect.die("interaction.present not wired"),
        confirm: () => Effect.die("interaction.confirm not wired"),
        review: () =>
          Effect.succeed({
            decision: "yes" as const,
            path: "/tmp/test-prompt.md",
          }),
      },
    })

    return narrowR(
      PromptTool.effect({ mode: "review", content: "## Plan\\n- Step 1" }, ctx).pipe(
        Effect.map((result) => {
          expect(result.mode).toBe("review")
          if (result.mode === "review") {
            expect(result.decision).toBe("yes")
            expect(result.path).toBe("/tmp/test-prompt.md")
          }
        }),
      ),
    )
  })

  it.live("confirm mode: returns yes/no decision", () => {
    const ctx = testToolContext({
      interaction: {
        approve: () => Effect.die("interaction.approve not wired"),
        present: () => Effect.die("interaction.present not wired"),
        confirm: () => Effect.succeed("no" as const),
        review: () => Effect.die("interaction.review not wired"),
      },
    })

    return narrowR(
      PromptTool.effect({ mode: "confirm", content: "Proceed?" }, ctx).pipe(
        Effect.map((result) => {
          expect(result.mode).toBe("confirm")
          if (result.mode === "confirm") {
            expect(result.decision).toBe("no")
          }
        }),
      ),
    )
  })

  it.live("present mode: returns shown status", () => {
    const ctx = testToolContext({
      interaction: {
        approve: () => Effect.die("interaction.approve not wired"),
        present: () => Effect.void,
        confirm: () => Effect.die("interaction.confirm not wired"),
        review: () => Effect.die("interaction.review not wired"),
      },
    })

    return narrowR(
      PromptTool.effect({ mode: "present", content: "Info" }, ctx).pipe(
        Effect.map((result) => {
          expect(result.mode).toBe("present")
          if (result.mode === "present") {
            expect(result.status).toBe("shown")
          }
        }),
      ),
    )
  })
})
