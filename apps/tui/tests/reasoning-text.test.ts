/**
 * Reasoning summaries must read as separate lines.
 *
 * A model emits reasoning as a run of summaries, each its own bold markdown
 * heading, and `messagePartsReasoning` joins the parts with an empty string.
 * The pane showed the result as one unreadable line with the asterisks printed
 * literally, because reasoning rendered as plain text rather than through the
 * markdown element the reply already uses:
 *
 *     **Verifying final test output****Refactoring LedgerStore.list…**
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { reasoningMarkdown } from "../src/components/reasoning-text"

describe("reasoning text", () => {
  it.effect("colliding summaries are split onto their own paragraphs", () =>
    Effect.sync(() => {
      const collided = "**Verifying final test output and diff summary****Refactoring LedgerStore**"
      expect(reasoningMarkdown(collided)).toBe(
        "**Verifying final test output and diff summary**\n\n**Refactoring LedgerStore**",
      )
    }),
  )

  it.effect("a run of three summaries keeps every one", () =>
    Effect.sync(() => {
      const collided = "**One****Two****Three**"
      expect(reasoningMarkdown(collided)).toBe("**One**\n\n**Two**\n\n**Three**")
    }),
  )

  it.effect("summaries already separated are left alone", () =>
    Effect.sync(() => {
      const spaced = "**One**\n\n**Two**"
      expect(reasoningMarkdown(spaced)).toBe(spaced)
    }),
  )

  it.effect("a single summary keeps its emphasis for markdown to render", () =>
    Effect.sync(() => {
      expect(reasoningMarkdown("**Only one**")).toBe("**Only one**")
    }),
  )

  it.effect("plain reasoning without emphasis passes through", () =>
    Effect.sync(() => {
      expect(reasoningMarkdown("thinking about the problem")).toBe("thinking about the problem")
    }),
  )

  it.effect("empty reasoning stays empty", () =>
    Effect.sync(() => {
      expect(reasoningMarkdown("")).toBe("")
    }),
  )
})
