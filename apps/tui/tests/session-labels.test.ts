import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import { RGBA } from "@opentui/core"
import { buildTopRightLabels } from "../src/utils/session-labels"

const absent = Option.getOrUndefined(Option.none())

const theme = {
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
  warning: RGBA.fromHex("#ffaa00"),
  info: RGBA.fromHex("#00aaff"),
}

describe("buildTopRightLabels", () => {
  test("empty when no data", () => {
    const labels = buildTopRightLabels(absent, 0, absent, theme)
    expect(labels.length).toBe(0)
  })

  test("shows thinking level when set", () => {
    const labels = buildTopRightLabels("high", 0, absent, theme)
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("high")
    expect(labels[0]!.color).toBe(theme.info)
  })

  test("shows context utilization", () => {
    const labels = buildTopRightLabels(absent, 50_000, 200_000, theme)
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("50k (25%)")
    expect(labels[0]!.color).toBe(theme.textMuted)
  })

  test("context at 70% uses warning color", () => {
    const labels = buildTopRightLabels(absent, 70_000, 100_000, theme)
    expect(labels[0]!.color).toBe(theme.warning)
  })

  test("context at 90% uses error color", () => {
    const labels = buildTopRightLabels(absent, 95_000, 100_000, theme)
    expect(labels[0]!.color).toBe(theme.error)
  })

  test("full layout: context + thinking", () => {
    const labels = buildTopRightLabels("high", 10_000, 200_000, theme)
    expect(labels.length).toBe(2)
    expect(labels[0]!.text).toBe("10k (5%)")
    expect(labels[1]!.text).toBe("high")
  })

  test("skips context when tokens are 0", () => {
    const labels = buildTopRightLabels(absent, 0, 200_000, theme)
    expect(labels.length).toBe(0)
  })

  test("skips context when contextLength undefined", () => {
    const labels = buildTopRightLabels(absent, 50_000, absent, theme)
    expect(labels.length).toBe(0)
  })

  test("debug mode shows debug label", () => {
    const labels = buildTopRightLabels(absent, 0, absent, theme, { debugMode: true })
    expect(labels.length).toBe(1)
    expect(labels[0]!.text).toBe("debug")
  })
})
