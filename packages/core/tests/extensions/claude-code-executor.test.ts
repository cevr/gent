/**
 * Claude Code executor — SDK message → response part mapping unit tests.
 *
 * Validates the mapping logic without spawning a subprocess. Full
 * end-to-end coverage (executor through `ClaudeSdk.Test` driving a real
 * agent loop) lives in Commit 5.
 */
import { describe, test, expect } from "bun:test"
import {
  makeSdkResponsePartMapper,
  mapSdkMessageToResponseParts,
} from "@gent/extensions/acp-agents/claude-code-executor"
type SDKMessage = Parameters<typeof mapSdkMessageToResponseParts>[0]

const stubBase = { uuid: "u-1", session_id: "s-1", parent_tool_use_id: null }

describe("mapSdkMessageToResponseParts", () => {
  test("stream_event content_block_delta text_delta → text-delta", () => {
    const msg = {
      type: "stream_event",
      ...stubBase,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
    } as unknown as SDKMessage
    const parts = mapSdkMessageToResponseParts(msg)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "text-delta", id: "claude-text-0", delta: "hello" })
  })

  test("stream_event content_block_delta thinking_delta → reasoning-delta", () => {
    const msg = {
      type: "stream_event",
      ...stubBase,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "ponder" },
      },
    } as unknown as SDKMessage
    const parts = mapSdkMessageToResponseParts(msg)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "reasoning-delta",
      id: "claude-reasoning-0",
      delta: "ponder",
    })
  })

  test("assistant text block does NOT emit (stream_event is the source)", () => {
    const msg = {
      type: "assistant",
      ...stubBase,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    } as unknown as SDKMessage
    expect(mapSdkMessageToResponseParts(msg)).toEqual([])
  })

  test("assistant tool_use block → tool-started", () => {
    const msg = {
      type: "assistant",
      ...stubBase,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t-1", name: "read", input: { path: "/x" } }],
      },
    } as unknown as SDKMessage
    const parts = mapSdkMessageToResponseParts(msg)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      id: "t-1",
      name: "read",
      params: { path: "/x" },
      providerExecuted: false,
    })
  })

  test("user tool_result success → tool-completed", () => {
    const mapper = makeSdkResponsePartMapper()
    mapSdkMessageToResponseParts(
      {
        type: "assistant",
        ...stubBase,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t-1", name: "read", input: { path: "/x" } }],
        },
      } as unknown as SDKMessage,
      mapper,
    )
    const msg = {
      type: "user",
      ...stubBase,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t-1", content: "ok" }],
      },
    } as unknown as SDKMessage
    const parts = mapSdkMessageToResponseParts(msg, mapper)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "tool-result",
      id: "t-1",
      name: "read",
      result: "ok",
      encodedResult: "ok",
      isFailure: false,
      providerExecuted: false,
      preliminary: false,
    })
  })

  test("user tool_result with is_error → tool-failed", () => {
    const msg = {
      type: "user",
      ...stubBase,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t-2", is_error: true, content: "boom" }],
      },
    } as unknown as SDKMessage
    const parts = mapSdkMessageToResponseParts(msg)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "tool-result",
      id: "t-2",
      name: "external",
      result: "boom",
      encodedResult: { error: "boom" },
      isFailure: true,
    })
  })

  test("result success → finished with stop_reason", () => {
    const msg = {
      type: "result",
      subtype: "success",
      ...stubBase,
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 1,
      result: "",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {},
      permission_denials: [],
    } as unknown as SDKMessage
    const parts = mapSdkMessageToResponseParts(msg)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "finish",
      reason: "unknown",
      usage: {
        inputTokens: { total: 10 },
        outputTokens: { total: 5 },
      },
    })
  })

  test("system / status messages map to nothing", () => {
    const msg = {
      type: "system",
      subtype: "init",
      ...stubBase,
    } as unknown as SDKMessage
    expect(mapSdkMessageToResponseParts(msg)).toEqual([])
  })
})
