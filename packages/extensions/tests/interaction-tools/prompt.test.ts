import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { PromptTool } from "../../src/interaction-tools/prompt.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { runToolWithCtx } from "@gent/core-internal/test-utils"

describe("Prompt Tool", () => {
  it.live("review mode: writes content and returns decision", () => {
    const interaction = {
      approve: () => Effect.die("interaction.approve not wired"),
      present: () => Effect.die("interaction.present not wired"),
      confirm: () => Effect.die("interaction.confirm not wired"),
      review: () =>
        Effect.succeed({
          decision: "yes" as const,
          path: "/tmp/test-prompt.md",
        }),
    }
    const ctx = testToolContext({ Interaction: interaction })

    return narrowR(
      runToolWithCtx(PromptTool, { mode: "review", content: "## Plan\\n- Step 1" }, ctx).pipe(
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
    const interaction = {
      approve: () => Effect.die("interaction.approve not wired"),
      present: () => Effect.die("interaction.present not wired"),
      confirm: () => Effect.succeed("no" as const),
      review: () => Effect.die("interaction.review not wired"),
    }
    const ctx = testToolContext({ Interaction: interaction })

    return narrowR(
      runToolWithCtx(PromptTool, { mode: "confirm", content: "Proceed?" }, ctx).pipe(
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
    const interaction = {
      approve: () => Effect.die("interaction.approve not wired"),
      present: () => Effect.void,
      confirm: () => Effect.die("interaction.confirm not wired"),
      review: () => Effect.die("interaction.review not wired"),
    }
    const ctx = testToolContext({ Interaction: interaction })

    return narrowR(
      runToolWithCtx(PromptTool, { mode: "present", content: "Info" }, ctx).pipe(
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
