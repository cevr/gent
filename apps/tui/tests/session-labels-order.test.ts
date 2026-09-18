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
import { Option } from "effect"
import { RGBA } from "@opentui/core"
import { buildContextLabels, buildTopRightLabels } from "../src/session"
import type { ModelContextMetrics } from "@gent/core/protocol"

const theme = {
  textMuted: RGBA.fromInts(138, 138, 138, 255),
  error: RGBA.fromInts(255, 0, 0, 255),
  warning: RGBA.fromInts(255, 200, 0, 255),
  info: RGBA.fromInts(0, 200, 255, 255),
}

const texts = (items: ReadonlyArray<{ text: string }>) => items.map((item) => item.text)

// `buildContextLabels` mirrors the client snapshot's optional fields, so its
// absent values are genuinely undefined at this boundary. Naming them keeps
// the intent readable where the signature cannot use Option.
// eslint-disable-next-line effect/noNullish -- matches the helper's optional parameters.
const NO_CONTEXT_LENGTH: number | undefined = undefined
// eslint-disable-next-line effect/noNullish -- matches the helper's optional parameters.
const NO_CONTEXT: undefined = undefined

const contextLabels = (
  latestInputTokens: number,
  // eslint-disable-next-line effect/noNullish -- matches the helper's optional parameter.
  contextLength: number | undefined,
  context?: ModelContextMetrics,
) =>
  buildContextLabels({
    metrics: { latestInputTokens, context: Option.fromNullishOr(context) },
    contextLength,
    theme,
  })

describe("effort sits with the model and the gauge anchors right", () => {
  test("reports the effort without the context gauge", () => {
    const labels = buildTopRightLabels({
      reasoningLevel: Option.some("medium"),
      theme,
      debugMode: false,
    })
    expect(texts(labels)).toEqual(["medium"])
  })

  test("reports no effort when none is set", () => {
    const labels = buildTopRightLabels({
      reasoningLevel: Option.none(),
      theme,
      debugMode: false,
    })
    expect(texts(labels)).toEqual([])
  })

  test("reports a projected context percentage on its own", () => {
    const labels = contextLabels(0, NO_CONTEXT_LENGTH, {
      estimatedTokens: 2_000,
      availableInputTokens: 8_000,
      contextLimitTokens: 10_000,
      omittedMessages: 0,
      compactions: 0,
    })
    expect(texts(labels)).toEqual(["ctx 20%"])
  })

  test("falls back to a usage-derived percentage", () => {
    const labels = contextLabels(5_000, 10_000, NO_CONTEXT)
    expect(texts(labels)[0]).toContain("50%")
  })

  test("reports nothing when there is no context to report", () => {
    expect(texts(contextLabels(0, NO_CONTEXT_LENGTH, NO_CONTEXT))).toEqual([])
  })
})
