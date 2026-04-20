/**
 * Claude Code executor — SDK message → TurnEvent mapping unit tests.
 *
 * Validates the mapping logic without spawning a subprocess. Full
 * end-to-end coverage (executor through `ClaudeSdk.Test` driving a real
 * agent loop) lives in Commit 5.
 */
import { describe, test, expect } from "bun:test"
import { mapSdkMessage } from "@gent/extensions/acp-agents/claude-code-executor"
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SDK types are noisy; tests only build the fields the mapper reads.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

const stubBase = { uuid: "u-1", session_id: "s-1", parent_tool_use_id: null }

describe("mapSdkMessage", () => {
  test("assistant text block → text-delta", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const msg = {
      type: "assistant",
      ...stubBase,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    } as unknown as SDKMessage
    const events = mapSdkMessage(msg)
    expect(events).toEqual([{ _tag: "text-delta", text: "hello" }])
  })

  test("assistant thinking block → reasoning-delta", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const msg = {
      type: "assistant",
      ...stubBase,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "ponder" }],
      },
    } as unknown as SDKMessage
    expect(mapSdkMessage(msg)).toEqual([{ _tag: "reasoning-delta", text: "ponder" }])
  })

  test("assistant tool_use block → tool-started", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const msg = {
      type: "assistant",
      ...stubBase,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t-1", name: "read", input: { path: "/x" } }],
      },
    } as unknown as SDKMessage
    expect(mapSdkMessage(msg)).toEqual([
      { _tag: "tool-started", toolCallId: "t-1", toolName: "read", input: { path: "/x" } },
    ])
  })

  test("user tool_result success → tool-completed", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const msg = {
      type: "user",
      ...stubBase,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t-1", content: "ok" }],
      },
    } as unknown as SDKMessage
    expect(mapSdkMessage(msg)).toEqual([
      { _tag: "tool-completed", toolCallId: "t-1", output: "ok" },
    ])
  })

  test("user tool_result with is_error → tool-failed", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const msg = {
      type: "user",
      ...stubBase,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t-2", is_error: true, content: "boom" }],
      },
    } as unknown as SDKMessage
    expect(mapSdkMessage(msg)).toEqual([{ _tag: "tool-failed", toolCallId: "t-2", error: "boom" }])
  })

  test("result success → finished with stop_reason", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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
    expect(mapSdkMessage(msg)).toEqual([
      {
        _tag: "finished",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ])
  })

  test("system / status messages map to nothing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const msg = {
      type: "system",
      subtype: "init",
      ...stubBase,
    } as unknown as SDKMessage
    expect(mapSdkMessage(msg)).toEqual([])
  })
})
