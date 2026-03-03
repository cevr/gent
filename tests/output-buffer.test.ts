import { describe, test, expect } from "bun:test"
import { OutputBuffer, headTail, formatHeadTail, headTailChars } from "@gent/core"

describe("headTail", () => {
  test("returns all items when under limit", () => {
    const result = headTail([1, 2, 3], 10)
    expect(result.head).toEqual([1, 2, 3])
    expect(result.tail).toEqual([])
    expect(result.truncatedCount).toBe(0)
  })

  test("splits evenly when over limit", () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    const result = headTail(items, 10)
    expect(result.head).toEqual([0, 1, 2, 3, 4])
    expect(result.tail).toEqual([15, 16, 17, 18, 19])
    expect(result.truncatedCount).toBe(10)
  })

  test("handles exact limit", () => {
    const result = headTail([1, 2, 3, 4], 4)
    expect(result.head).toEqual([1, 2, 3, 4])
    expect(result.truncatedCount).toBe(0)
  })

  test("handles empty array", () => {
    const result = headTail([], 10)
    expect(result.head).toEqual([])
    expect(result.truncatedCount).toBe(0)
  })
})

describe("formatHeadTail", () => {
  test("joins all items when under limit", () => {
    expect(formatHeadTail(["a", "b", "c"], 10)).toBe("a\nb\nc")
  })

  test("inserts truncation marker", () => {
    const items = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const result = formatHeadTail(items, 6)
    expect(result).toContain("... [14 lines truncated] ...")
    expect(result.startsWith("line 0")).toBe(true)
    expect(result.endsWith("line 19")).toBe(true)
  })

  test("custom truncation message", () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i}`)
    const result = formatHeadTail(items, 4, (n) => `[${n} omitted]`)
    expect(result).toContain("[6 omitted]")
  })
})

describe("headTailChars", () => {
  test("returns full text when under limit", () => {
    const result = headTailChars("hello", 100)
    expect(result.text).toBe("hello")
    expect(result.truncated).toBe(false)
  })

  test("truncates long text", () => {
    const text = "x".repeat(200)
    const result = headTailChars(text, 100)
    expect(result.truncated).toBe(true)
    expect(result.totalChars).toBe(200)
    expect(result.text).toContain("characters truncated")
  })
})

describe("OutputBuffer", () => {
  test("small output — no truncation", () => {
    const buf = new OutputBuffer(5, 5)
    buf.add("line 1\nline 2\nline 3\n")
    const result = buf.format()
    expect(result.truncatedLines).toBe(0)
    expect(result.text).toBe("line 1\nline 2\nline 3")
  })

  test("streaming chunks — partial lines", () => {
    const buf = new OutputBuffer(5, 5)
    buf.add("hel")
    buf.add("lo\nwor")
    buf.add("ld\n")
    const result = buf.format()
    expect(result.text).toBe("hello\nworld")
    expect(result.truncatedLines).toBe(0)
  })

  test("large output — head + tail with truncation", () => {
    const buf = new OutputBuffer(3, 3)
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    buf.add(lines.join("\n") + "\n")
    const result = buf.format()

    expect(result.truncatedLines).toBe(14)
    expect(result.text).toContain("line 0")
    expect(result.text).toContain("line 1")
    expect(result.text).toContain("line 2")
    expect(result.text).toContain("line 17")
    expect(result.text).toContain("line 18")
    expect(result.text).toContain("line 19")
    expect(result.text).toContain("[14 lines truncated]")
  })

  test("exactly head+tail lines — no truncation marker", () => {
    const buf = new OutputBuffer(3, 3)
    const lines = Array.from({ length: 6 }, (_, i) => `line ${i}`)
    buf.add(lines.join("\n") + "\n")
    const result = buf.format()

    expect(result.truncatedLines).toBe(0)
    expect(result.text).toBe("line 0\nline 1\nline 2\nline 3\nline 4\nline 5")
  })

  test("deduplication — overlap between head and tail", () => {
    const buf = new OutputBuffer(5, 5)
    // 7 lines: head=[0..4], tail=[2..6] — overlap on 2,3,4
    const lines = Array.from({ length: 7 }, (_, i) => `line ${i}`)
    buf.add(lines.join("\n") + "\n")
    const result = buf.format()

    expect(result.truncatedLines).toBe(0)
    // Should contain all 7 lines exactly once
    const outputLines = result.text.split("\n")
    expect(outputLines.length).toBe(7)
    expect(outputLines[0]).toBe("line 0")
    expect(outputLines[6]).toBe("line 6")
  })

  test("pending line flushed on format", () => {
    const buf = new OutputBuffer(5, 5)
    buf.add("hello\nworld") // "world" is pending (no trailing newline)
    const result = buf.format()
    expect(result.text).toBe("hello\nworld")
  })

  test("totalLines tracked correctly", () => {
    const buf = new OutputBuffer(3, 3)
    buf.add("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n")
    expect(buf.totalLines).toBe(10)
  })
})
