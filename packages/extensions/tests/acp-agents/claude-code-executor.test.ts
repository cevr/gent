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
} from "../../src/acp-agents/claude-code-executor.js"
type SDKMessage = Parameters<typeof mapSdkMessageToResponseParts>[0]
type StreamEventMessage = Extract<SDKMessage, { type: "stream_event" }>
type AssistantMessage = Extract<SDKMessage, { type: "assistant" }>
type UserMessage = Exclude<Extract<SDKMessage, { type: "user" }>, { isReplay: true }>
type ResultMessage = Extract<SDKMessage, { type: "result"; subtype: "success" }>
type SystemInitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>

const UUID: `${string}-${string}-${string}-${string}-${string}` =
  "00000000-0000-4000-8000-000000000001"
const stubBase = { uuid: UUID, session_id: "s-1", parent_tool_use_id: null }
const usage = (
  inputTokens: number,
  outputTokens: number,
): AssistantMessage["message"]["usage"] & ResultMessage["usage"] => ({
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  inference_geo: "test",
  input_tokens: inputTokens,
  iterations: [],
  output_tokens: outputTokens,
  server_tool_use: {
    web_fetch_requests: 0,
    web_search_requests: 0,
  },
  service_tier: "standard",
  speed: "standard",
})

const sdkStreamEvent = (event: StreamEventMessage["event"]): StreamEventMessage => ({
  type: "stream_event",
  ...stubBase,
  event,
})

const sdkAssistant = (content: AssistantMessage["message"]["content"]): AssistantMessage => ({
  type: "assistant",
  ...stubBase,
  message: {
    id: "msg_1",
    type: "message",
    container: null,
    context_management: null,
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: null,
    stop_sequence: null,
    usage: usage(0, 0),
  },
})

const sdkUser = (content: UserMessage["message"]["content"]): UserMessage => ({
  type: "user",
  ...stubBase,
  message: {
    role: "user",
    content,
  },
})

const sdkResultSuccess = (
  overrides: Partial<Omit<ResultMessage, "type" | "subtype" | "uuid" | "session_id">> = {},
): ResultMessage => ({
  type: "result",
  subtype: "success",
  uuid: stubBase.uuid,
  session_id: stubBase.session_id,
  duration_ms: 0,
  duration_api_ms: 0,
  is_error: false,
  num_turns: 1,
  result: "",
  stop_reason: "end_turn",
  total_cost_usd: 0,
  usage: usage(10, 5),
  modelUsage: {},
  permission_denials: [],
  ...overrides,
})

const sdkSystemInit = (): SystemInitMessage => ({
  type: "system",
  subtype: "init",
  uuid: stubBase.uuid,
  session_id: stubBase.session_id,
  apiKeySource: "user",
  claude_code_version: "test",
  cwd: "/tmp",
  tools: [],
  mcp_servers: [],
  model: "claude-test",
  permissionMode: "default",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
})

describe("mapSdkMessageToResponseParts", () => {
  test("stream_event content_block_delta text_delta → text-delta", () => {
    const msg = sdkStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    })
    const parts = mapSdkMessageToResponseParts(msg)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: "text-delta", id: "claude-text-0", delta: "hello" })
  })

  test("stream_event content_block_delta thinking_delta → reasoning-delta", () => {
    const msg = sdkStreamEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "ponder" },
    })
    const parts = mapSdkMessageToResponseParts(msg)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: "reasoning-delta",
      id: "claude-reasoning-0",
      delta: "ponder",
    })
  })

  test("assistant text block does NOT emit (stream_event is the source)", () => {
    const msg = sdkAssistant([{ type: "text", text: "hello", citations: null }])
    expect(mapSdkMessageToResponseParts(msg)).toEqual([])
  })

  test("assistant tool_use block → tool-started", () => {
    const msg = sdkAssistant([{ type: "tool_use", id: "t-1", name: "read", input: { path: "/x" } }])
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
      sdkAssistant([{ type: "tool_use", id: "t-1", name: "read", input: { path: "/x" } }]),
      mapper,
    )
    const msg = sdkUser([{ type: "tool_result", tool_use_id: "t-1", content: "ok" }])
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
    const msg = sdkUser([
      { type: "tool_result", tool_use_id: "t-2", is_error: true, content: "boom" },
    ])
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
    const msg = sdkResultSuccess()
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
    const msg = sdkSystemInit()
    expect(mapSdkMessageToResponseParts(msg)).toEqual([])
  })
})
