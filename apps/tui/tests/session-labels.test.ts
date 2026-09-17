import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import { MessageId, type ModelContextMetrics } from "@gent/core/protocol"
import { RGBA } from "@opentui/core"
import { buildContextLabels, buildTopRightLabels, formatCwdGit } from "../src/utils/session-labels"

const absent = Option.getOrUndefined(Option.none())

const theme = {
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
  warning: RGBA.fromHex("#ffaa00"),
  info: RGBA.fromHex("#00aaff"),
}

const contextLabels = (
  latestInputTokens: number,
  // eslint-disable-next-line effect/noNullish -- mirrors the optional client snapshot field.
  contextLength: number | undefined,
  context?: ModelContextMetrics,
) =>
  buildContextLabels({
    metrics: { latestInputTokens, context: Option.fromNullishOr(context) },
    contextLength,
    theme,
  })

describe("buildTopRightLabels", () => {
  test("empty when no data", () => {
    const labels = buildTopRightLabels(absent, theme)
    expect(labels.length).toBe(0)
  })

  test("shows thinking level when set", () => {
    const labels = buildTopRightLabels("high", theme)
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("high")
    expect(labels[0]!.color).toBe(theme.info)
  })

  test("debug mode shows debug label", () => {
    const labels = buildTopRightLabels(absent, theme, { debugMode: true })
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("debug")
  })

  test("carries no context gauge — that anchors to the right edge", () => {
    const labels = buildTopRightLabels("high", theme, { debugMode: true })
    expect(labels.map((label) => label.text)).toEqual(["high", "debug"])
  })
})

describe("buildContextLabels", () => {
  test("shows context utilization", () => {
    const labels = contextLabels(50_000, 200_000, absent)
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("50k (25%)")
    expect(labels[0]!.color).toBe(theme.textMuted)
  })

  test("context at 70% uses warning color", () => {
    const labels = contextLabels(70_000, 100_000, absent)
    expect(labels[0]!.color).toBe(theme.warning)
  })

  test("context at 90% uses error color", () => {
    const labels = contextLabels(95_000, 100_000, absent)
    expect(labels[0]!.color).toBe(theme.error)
  })

  test("a projection replaces the usage estimate with what the model saw", () => {
    const labels = contextLabels(50_000, 200_000, {
      estimatedTokens: 84_000,
      availableInputTokens: 190_000,
      contextLimitTokens: 200_000,
      omittedMessages: 3,
      compactions: 2,
      handoffMessageId: MessageId.make("context-handoff:b:m"),
    })
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("ctx 42%")
    expect(labels[0]!.color).toBe(theme.textMuted)
  })

  test("a projection with nothing dropped shows only the percent", () => {
    const labels = contextLabels(0, absent, {
      estimatedTokens: 180_000,
      availableInputTokens: 190_000,
      contextLimitTokens: 200_000,
      omittedMessages: 0,
      compactions: 0,
    })
    expect(labels[0]!.text).toBe("ctx 90%")
    expect(labels[0]!.color).toBe(theme.error)
  })

  test("a summary-free projection does not label the old compaction count", () => {
    const labels = contextLabels(0, absent, {
      estimatedTokens: 1000,
      availableInputTokens: 190000,
      contextLimitTokens: 200000,
      omittedMessages: 0,
      compactions: 2,
    })
    expect(labels[0]?.text).toBe("ctx 1%")
  })

  test("skips context when tokens are 0", () => {
    expect(contextLabels(0, 200_000, absent).length).toBe(0)
  })

  test("skips context when contextLength undefined", () => {
    expect(contextLabels(50_000, absent, absent).length).toBe(0)
  })
})

describe("formatCwdGit", () => {
  test("cwd at the git root shows the repo name", () => {
    expect(formatCwdGit("/home/u/repo", Option.some("/home/u/repo"), Option.none())).toBe("repo")
  })

  test("cwd under the git root shows the path relative to the repo", () => {
    expect(formatCwdGit("/home/u/repo/apps/tui", Option.some("/home/u/repo"), Option.none())).toBe(
      "repo/apps/tui",
    )
  })

  test("cwd outside the git root falls back to the repo name", () => {
    expect(formatCwdGit("/elsewhere", Option.some("/home/u/repo"), Option.none())).toBe("repo")
  })

  test("no git root shows the last cwd segment", () => {
    expect(formatCwdGit("/home/u/scratch", Option.none(), Option.none())).toBe("scratch")
  })

  test("a non-empty branch is appended in parentheses", () => {
    expect(formatCwdGit("/home/u/repo", Option.some("/home/u/repo"), Option.some("main"))).toBe(
      "repo (main)",
    )
    expect(formatCwdGit("/home/u/repo", Option.some("/home/u/repo"), Option.some(""))).toBe("repo")
  })
})
