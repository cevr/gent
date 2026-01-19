import { describe, test, expect } from "bun:test"
import {
  isRetryable,
  getRetryDelay,
  DEFAULT_RETRY_CONFIG,
  pruneToolOutputs,
  estimateTokens,
  DEFAULT_COMPACTION_CONFIG,
} from "@gent/runtime"
import { ProviderError } from "@gent/providers"
import { Message, TextPart, ToolResultPart } from "@gent/core"

describe("Retry Logic", () => {
  test("isRetryable detects rate limits", () => {
    const rateLimitError = new ProviderError({
      message: "Rate limit exceeded (429)",
      model: "test",
    })
    expect(isRetryable(rateLimitError)).toBe(true)
  })

  test("isRetryable detects overload", () => {
    const overloadError = new ProviderError({
      message: "Service overloaded",
      model: "test",
    })
    expect(isRetryable(overloadError)).toBe(true)
  })

  test("isRetryable detects 500 errors", () => {
    const serverError = new ProviderError({
      message: "Internal server error 500",
      model: "test",
    })
    expect(isRetryable(serverError)).toBe(true)
  })

  test("isRetryable returns false for non-retryable errors", () => {
    const authError = new ProviderError({
      message: "Invalid API key",
      model: "test",
    })
    expect(isRetryable(authError)).toBe(false)
  })

  test("getRetryDelay uses exponential backoff", () => {
    const delay0 = getRetryDelay(0, null)
    const delay1 = getRetryDelay(1, null)
    const delay2 = getRetryDelay(2, null)

    expect(delay0).toBe(DEFAULT_RETRY_CONFIG.initialDelay)
    expect(delay1).toBe(DEFAULT_RETRY_CONFIG.initialDelay * 2)
    expect(delay2).toBe(DEFAULT_RETRY_CONFIG.initialDelay * 4)
  })

  test("getRetryDelay respects maxDelay", () => {
    const delay = getRetryDelay(10, null)
    expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_CONFIG.maxDelay)
  })
})

describe("Compaction", () => {
  test("estimateTokens calculates token count", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "Hello world" })], // 11 chars
        createdAt: new Date(),
      }),
    ]

    const tokens = estimateTokens(messages)
    expect(tokens).toBe(3) // ceil(11/4) = 3
  })

  test("pruneToolOutputs preserves recent outputs", () => {
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
            output: { type: "json", value: { data: "x".repeat(1000) } },
          }),
        ],
        createdAt: new Date(),
      }),
    ]

    // With high pruneProtect, nothing should be pruned
    const config = { ...DEFAULT_COMPACTION_CONFIG, pruneProtect: 100000 }
    const result = pruneToolOutputs(messages, config)
    expect(result.length).toBe(1)
    const firstMessage = result[0]
    expect(firstMessage).toBeDefined()
    const firstPart = firstMessage?.parts[0] as ToolResultPart | undefined
    expect(firstPart).toBeDefined()
    expect(firstPart?.output.value).not.toHaveProperty("_pruned")
  })
})
