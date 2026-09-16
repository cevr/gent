/**
 * The status row reads left to right as: where you are, what you are running
 * it with, how full it is, what it cost. Each label's neighbours are the
 * specification, not an accident of which builder happened to push first.
 *
 * Effort belongs beside the model because the two together name what is
 * answering — "Sonnet 5 at medium" is one fact — while the context gauge
 * belongs with the running total, since both describe the session's spend
 * rather than its configuration.
 */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { buildTopRightLabels } from "../src/utils/session-labels"

const theme = {
  textMuted: RGBA.fromInts(138, 138, 138, 255),
  error: RGBA.fromInts(255, 0, 0, 255),
  warning: RGBA.fromInts(255, 200, 0, 255),
  info: RGBA.fromInts(0, 200, 255, 255),
}

const texts = (items: ReadonlyArray<{ text: string }>) => items.map((item) => item.text)

// `buildTopRightLabels` mirrors the client snapshot's optional fields, so its
// absent values are genuinely undefined at this boundary. Naming them keeps
// the intent readable where the signature cannot use Option.
// eslint-disable-next-line effect/noNullish -- matches the helper's optional parameters.
const NO_CONTEXT_LENGTH: number | undefined = undefined
// eslint-disable-next-line effect/noNullish -- matches the helper's optional parameters.
const NO_EFFORT: string | undefined = undefined

describe("the model's effort sits beside the model, before the context gauge", () => {
  test("puts effort ahead of a projected context percentage", () => {
    const labels = buildTopRightLabels("medium", 0, NO_CONTEXT_LENGTH, theme, {
      context: {
        estimatedTokens: 2_000,
        availableInputTokens: 8_000,
        contextLimitTokens: 10_000,
        omittedMessages: 0,
        compactions: 0,
      },
    })
    expect(texts(labels)).toEqual(["medium", "ctx 20%"])
  })

  test("puts effort ahead of a usage-derived context percentage", () => {
    const labels = buildTopRightLabels("high", 5_000, 10_000, theme, {})
    expect(texts(labels)[0]).toBe("high")
    expect(texts(labels)[1]).toContain("50%")
  })

  test("still reports the gauge when no effort is set", () => {
    const labels = buildTopRightLabels(NO_EFFORT, 0, NO_CONTEXT_LENGTH, theme, {
      context: {
        estimatedTokens: 9_500,
        availableInputTokens: 500,
        contextLimitTokens: 10_000,
        omittedMessages: 0,
        compactions: 0,
      },
    })
    expect(texts(labels)).toEqual(["ctx 95%"])
  })
})
