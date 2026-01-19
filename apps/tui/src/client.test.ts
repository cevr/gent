import { describe, test, expect } from "bun:test"
import {
  extractText,
  extractToolCalls,
  buildToolResultMap,
  extractToolCallsWithResults,
  type MessageInfoReadonly,
} from "./client.js"
import type { MessagePart } from "@gent/core"

describe("extractText", () => {
  test("extracts text from text part", () => {
    const parts: MessagePart[] = [{ type: "text", text: "Hello world" }]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("returns empty string when no text part", () => {
    const parts: MessagePart[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
    ]
    expect(extractText(parts)).toBe("")
  })

  test("returns first text part when multiple", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]
    expect(extractText(parts)).toBe("First")
  })

  test("handles mixed parts", () => {
    const parts: MessagePart[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
      { type: "text", text: "Response after tool" },
    ]
    expect(extractText(parts)).toBe("Response after tool")
  })

  test("returns empty string for empty parts", () => {
    expect(extractText([])).toBe("")
  })
})

describe("extractToolCalls", () => {
  test("extracts tool calls from parts", () => {
    const parts: MessagePart[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "/foo" } },
      { type: "text", text: "Some text" },
      { type: "tool-call", toolCallId: "tc2", toolName: "edit", input: { path: "/bar" } },
    ]

    const calls = extractToolCalls(parts)
    expect(calls.length).toBe(2)
    expect(calls[0]).toEqual({
      id: "tc1",
      toolName: "read",
      status: "completed",
      input: { path: "/foo" },
      summary: undefined,
      output: undefined,
    })
    expect(calls[1]).toEqual({
      id: "tc2",
      toolName: "edit",
      status: "completed",
      input: { path: "/bar" },
      summary: undefined,
      output: undefined,
    })
  })

  test("returns empty array when no tool calls", () => {
    const parts: MessagePart[] = [{ type: "text", text: "Just text" }]
    expect(extractToolCalls(parts)).toEqual([])
  })
})

describe("buildToolResultMap", () => {
  const makeMsg = (
    role: "user" | "assistant" | "tool",
    parts: MessagePart[]
  ): MessageInfoReadonly => ({
    id: crypto.randomUUID(),
    sessionId: "s1",
    branchId: "b1",
    role,
    parts,
    createdAt: Date.now(),
    turnDurationMs: undefined,
  })

  // Helper to create tool result parts with all required fields
  const toolResult = (
    toolCallId: string,
    value: unknown,
    isError = false
  ): MessagePart => ({
    type: "tool-result",
    toolCallId,
    toolName: "test-tool",
    output: { type: isError ? "error-json" : "json", value },
  })

  test("builds map from tool messages", () => {
    const messages: MessageInfoReadonly[] = [
      makeMsg("assistant", [
        { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
      ]),
      makeMsg("tool", [toolResult("tc1", "file contents here")]),
    ]

    const map = buildToolResultMap(messages)
    expect(map.size).toBe(1)
    expect(map.get("tc1")).toEqual({
      summary: "file contents here",
      output: "file contents here",
      isError: false,
    })
  })

  test("handles error results", () => {
    const messages: MessageInfoReadonly[] = [
      makeMsg("tool", [toolResult("tc1", "File not found", true)]),
    ]

    const map = buildToolResultMap(messages)
    expect(map.get("tc1")).toEqual({
      summary: "File not found",
      output: "File not found",
      isError: true,
    })
  })

  test("truncates long output in summary", () => {
    const longText = "x".repeat(150)
    const messages: MessageInfoReadonly[] = [
      makeMsg("tool", [toolResult("tc1", longText)]),
    ]

    const map = buildToolResultMap(messages)
    const result = map.get("tc1")!
    expect(result.summary.length).toBe(103) // 100 + "..."
    expect(result.summary.endsWith("...")).toBe(true)
    expect(result.output).toBe(longText) // full output preserved
  })

  test("summary uses first line only", () => {
    const multiline = "First line\nSecond line\nThird line"
    const messages: MessageInfoReadonly[] = [
      makeMsg("tool", [toolResult("tc1", multiline)]),
    ]

    const map = buildToolResultMap(messages)
    expect(map.get("tc1")?.summary).toBe("First line")
  })

  test("handles object output", () => {
    const messages: MessageInfoReadonly[] = [
      makeMsg("tool", [toolResult("tc1", { files: ["a.ts", "b.ts"] })]),
    ]

    const map = buildToolResultMap(messages)
    const result = map.get("tc1")!
    expect(result.summary).toBe('{"files":["a.ts","b.ts"]}')
    expect(result.output).toContain('"files"')
  })

  test("handles multiple tool results", () => {
    const messages: MessageInfoReadonly[] = [
      makeMsg("tool", [toolResult("tc1", "result1"), toolResult("tc2", "result2")]),
    ]

    const map = buildToolResultMap(messages)
    expect(map.size).toBe(2)
    expect(map.get("tc1")?.output).toBe("result1")
    expect(map.get("tc2")?.output).toBe("result2")
  })

  test("ignores non-tool messages", () => {
    const messages: MessageInfoReadonly[] = [
      makeMsg("user", [{ type: "text", text: "Hello" }]),
      makeMsg("assistant", [{ type: "text", text: "Hi there" }]),
    ]

    const map = buildToolResultMap(messages)
    expect(map.size).toBe(0)
  })
})

describe("extractToolCallsWithResults", () => {
  test("joins tool calls with results from map", () => {
    const parts: MessagePart[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "/foo" } },
    ]
    const resultMap = new Map([
      ["tc1", { summary: "50 lines", output: "full content", isError: false }],
    ])

    const calls = extractToolCallsWithResults(parts, resultMap)
    expect(calls[0]).toEqual({
      id: "tc1",
      toolName: "read",
      status: "completed",
      input: { path: "/foo" },
      summary: "50 lines",
      output: "full content",
    })
  })

  test("marks error results with error status", () => {
    const parts: MessagePart[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
    ]
    const resultMap = new Map([
      ["tc1", { summary: "Error", output: "File not found", isError: true }],
    ])

    const calls = extractToolCallsWithResults(parts, resultMap)
    expect(calls[0]?.status).toBe("error")
  })

  test("handles missing results gracefully", () => {
    const parts: MessagePart[] = [
      { type: "tool-call", toolCallId: "tc1", toolName: "read", input: {} },
    ]
    const resultMap = new Map<string, { summary: string; output: string; isError: boolean }>()

    const calls = extractToolCallsWithResults(parts, resultMap)
    expect(calls[0]).toEqual({
      id: "tc1",
      toolName: "read",
      status: "completed",
      input: {},
      summary: undefined,
      output: undefined,
    })
  })
})
