import { describe, test, expect } from "bun:test"
import {
  stringifyOutput,
  summarizeOutput,
  summarizeToolOutput,
} from "@gent/core/domain/tool-output"
import { ToolResultPart } from "@gent/core/domain/message"

describe("stringifyOutput", () => {
  test("string passthrough", () => {
    expect(stringifyOutput("hello")).toBe("hello")
  })

  test("object → JSON", () => {
    expect(stringifyOutput({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  test("number → JSON", () => {
    expect(stringifyOutput(42)).toBe("42")
  })

  test("null → JSON", () => {
    expect(stringifyOutput(null)).toBe("null")
  })
})

describe("summarizeOutput", () => {
  test("short string → first line", () => {
    const result = summarizeOutput({ type: "json", value: "short result" })
    expect(result).toBe("short result")
  })

  test("multiline string → first line only", () => {
    const result = summarizeOutput({ type: "json", value: "line1\nline2\nline3" })
    expect(result).toBe("line1")
  })

  test("long first line → truncated at 100 chars", () => {
    const long = "x".repeat(150)
    const result = summarizeOutput({ type: "json", value: long })
    expect(result.length).toBe(103) // 100 + "..."
    expect(result.endsWith("...")).toBe(true)
  })

  test("object → JSON truncated", () => {
    const result = summarizeOutput({ type: "json", value: { key: "value" } })
    expect(result).toContain("key")
  })

  test("large object → truncated at 100 chars", () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, `value${i}`]))
    const result = summarizeOutput({ type: "json", value: big })
    expect(result.length).toBeLessThanOrEqual(103)
    expect(result.endsWith("...")).toBe(true)
  })
})

describe("summarizeToolOutput", () => {
  test("delegates to summarizeOutput", () => {
    const part = new ToolResultPart({
      type: "tool-result",
      toolCallId: "tc1",
      toolName: "read",
      output: { type: "json", value: "file contents" },
    })
    expect(summarizeToolOutput(part)).toBe("file contents")
  })
})
