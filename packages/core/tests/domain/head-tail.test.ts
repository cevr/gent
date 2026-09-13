import { describe, test, expect } from "bun:test"
import { headTail, formatHeadTail, headTailChars } from "../../src/domain/head-tail"

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
