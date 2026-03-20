import { describe, test, expect } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  buildBorderSegments,
  type BorderLabelItem,
  type Segment,
} from "../src/utils/border-segments"

const bc = RGBA.fromHex("#888888")
const accent = RGBA.fromHex("#ff0000")

function segText(segments: Segment[]): string {
  return segments.map((s) => s.text).join("")
}

describe("buildBorderSegments", () => {
  test("no labels — full fill", () => {
    const segs = buildBorderSegments(40, [], [], bc)
    const text = segText(segs)
    expect(text).toBe("─".repeat(40))
    expect(text.length).toBe(40)
  })

  test("left labels only", () => {
    const left: BorderLabelItem[] = [{ text: "hello", color: accent }]
    const segs = buildBorderSegments(40, left, [], bc)
    const text = segText(segs)
    // "── hello " + fill
    expect(text.startsWith("── hello ")).toBe(true)
    expect(text.length).toBe(40)
    // No corner chars
    expect(text).not.toContain("╭")
    expect(text).not.toContain("╮")
  })

  test("right labels only", () => {
    const right: BorderLabelItem[] = [{ text: "gent", color: accent }]
    const segs = buildBorderSegments(40, [], right, bc)
    const text = segText(segs)
    expect(text.endsWith(" gent ──")).toBe(true)
    expect(text.length).toBe(40)
  })

  test("left + right labels", () => {
    const left: BorderLabelItem[] = [{ text: "$0.14", color: accent }]
    const right: BorderLabelItem[] = [{ text: "opus", color: accent }]
    const segs = buildBorderSegments(40, left, right, bc)
    const text = segText(segs)
    expect(text.startsWith("── $0.14 ")).toBe(true)
    expect(text.endsWith(" opus ──")).toBe(true)
    expect(text.length).toBe(40)
  })

  test("multiple left labels separated by ·", () => {
    const left: BorderLabelItem[] = [
      { text: "a", color: accent },
      { text: "b", color: accent },
    ]
    const segs = buildBorderSegments(40, left, [], bc)
    const text = segText(segs)
    expect(text.startsWith("── a · b ")).toBe(true)
  })

  test("multiple right labels separated by ·", () => {
    const right: BorderLabelItem[] = [
      { text: "x", color: accent },
      { text: "y", color: accent },
    ]
    const segs = buildBorderSegments(40, [], right, bc)
    const text = segText(segs)
    expect(text.endsWith(" x · y ──")).toBe(true)
  })

  test("label colors preserved", () => {
    const left: BorderLabelItem[] = [{ text: "cost", color: accent }]
    const segs = buildBorderSegments(40, left, [], bc)
    // Find the segment with "cost" text
    const costSeg = segs.find((s) => s.text === "cost")
    expect(costSeg).toBeDefined()
    expect(costSeg!.color).toBe(accent)
    // Border chars use bc
    expect(segs[0]!.color).toBe(bc)
  })

  test("fill never negative with long labels", () => {
    const left: BorderLabelItem[] = [{ text: "x".repeat(50), color: accent }]
    const segs = buildBorderSegments(20, left, [], bc)
    // Should not throw, fill clamped to 0
    const text = segText(segs)
    expect(text.length).toBeGreaterThanOrEqual(50)
  })

  test("no corner characters anywhere", () => {
    const left: BorderLabelItem[] = [{ text: "test", color: accent }]
    const right: BorderLabelItem[] = [{ text: "end", color: accent }]
    const segs = buildBorderSegments(40, left, right, bc)
    const text = segText(segs)
    expect(text).not.toContain("╭")
    expect(text).not.toContain("╮")
    expect(text).not.toContain("╰")
    expect(text).not.toContain("╯")
  })
})
