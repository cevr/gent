import { describe, test, expect } from "effect-bun-test"
import {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ImagePart,
} from "@gent/core/domain/message"
import {
  estimateTokens,
  estimateContextPercent,
  getContextWindow,
} from "@gent/core/runtime/context-estimation"

// ============================================================================
// estimateContextPercent / getContextWindow
// ============================================================================

describe("estimateContextPercent", () => {
  test("returns 0 for empty messages", () => {
    // System overhead only: 4000 tokens / 1000000 = 0.4% → 0
    const percent = estimateContextPercent([], "anthropic/claude-opus-4-6")
    expect(percent).toBe(0)
  })

  test("calculates percent against model context window", () => {
    // 800 chars = 200 tokens. + 4000 overhead = 4200 tokens. / 1000000 = 0.42% → 0
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(800) })],
        createdAt: new Date(),
      }),
    ]
    const percent = estimateContextPercent(messages, "anthropic/claude-opus-4-6")
    expect(percent).toBe(0)
  })

  test("larger messages increase percent", () => {
    // 40000 chars = 10000 tokens. + 4000 = 14000. / 1000000 = 1.4% → 1
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(40_000) })],
        createdAt: new Date(),
      }),
    ]
    const percent = estimateContextPercent(messages, "anthropic/claude-opus-4-6")
    expect(percent).toBe(1)
  })

  test("respects different model context windows", () => {
    // 40000 chars = 10000 tokens. + 4000 = 14000. / 1000000 (codex) = 1.4% → 1
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(40_000) })],
        createdAt: new Date(),
      }),
    ]
    const percent = estimateContextPercent(messages, "openai/gpt-5.4")
    expect(percent).toBe(1)
  })

  test("multiple message types contribute to estimate", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(4_000) })],
        createdAt: new Date(),
      }),
      new Message({
        id: "m2",
        sessionId: "s",
        branchId: "b",
        role: "assistant",
        parts: [
          new TextPart({ type: "text", text: "y".repeat(4_000) }),
          new ToolCallPart({
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "test",
            input: { key: "v".repeat(2_000) },
          }),
        ],
        createdAt: new Date(),
      }),
      new Message({
        id: "m3",
        sessionId: "s",
        branchId: "b",
        role: "tool",
        parts: [
          new ToolResultPart({
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test",
            output: { type: "json", value: { result: "z".repeat(2_000) } },
          }),
        ],
        createdAt: new Date(),
      }),
    ]

    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)

    const percent = estimateContextPercent(messages, "anthropic/claude-opus-4-6")
    expect(percent).toBeGreaterThan(0) // more than just overhead
    expect(percent).toBeLessThan(100)
  })
})

describe("getContextWindow", () => {
  test("returns known model windows", () => {
    expect(getContextWindow("anthropic/claude-opus-4-6")).toBe(1_000_000)
    expect(getContextWindow("openai/gpt-5.4")).toBe(1_000_000)
    expect(getContextWindow("openai/gpt-5.4-mini")).toBe(1_000_000)
  })

  test("returns default for unknown models", () => {
    expect(getContextWindow("unknown/model")).toBe(200_000)
  })
})

// ============================================================================
// estimateTokens -- covers all part types
// ============================================================================

describe("estimateTokens", () => {
  test("text parts", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(100) })],
        createdAt: new Date(),
      }),
    ]
    expect(estimateTokens(messages)).toBe(25) // 100/4
  })

  test("tool-call parts use JSON.stringify of input", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "assistant",
        parts: [
          new ToolCallPart({
            type: "tool-call",
            toolCallId: "tc1",
            toolName: "test",
            input: { key: "value" },
          }),
        ],
        createdAt: new Date(),
      }),
    ]
    const tokens = estimateTokens(messages)
    const expectedChars = JSON.stringify({ key: "value" }).length
    expect(tokens).toBe(Math.ceil(expectedChars / 4))
  })

  test("tool-result parts use JSON.stringify of output", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "tool",
        parts: [
          new ToolResultPart({
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test",
            output: { type: "json", value: { data: "hello" } },
          }),
        ],
        createdAt: new Date(),
      }),
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
  })

  test("image parts estimate ~250 tokens", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new ImagePart({ type: "image", image: "data:image/png;base64,abc" })],
        createdAt: new Date(),
      }),
    ]
    expect(estimateTokens(messages)).toBe(250) // 1000/4
  })

  test("empty messages return 0", () => {
    expect(estimateTokens([])).toBe(0)
  })

  test("multiple messages sum correctly", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "x".repeat(100) })],
        createdAt: new Date(),
      }),
      new Message({
        id: "m2",
        sessionId: "s",
        branchId: "b",
        role: "assistant",
        parts: [new TextPart({ type: "text", text: "y".repeat(200) })],
        createdAt: new Date(),
      }),
    ]
    expect(estimateTokens(messages)).toBe(75) // (100+200)/4
  })
})
