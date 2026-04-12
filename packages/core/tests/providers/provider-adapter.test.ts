import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import {
  convertMessages,
  convertTools,
  toStreamChunk,
  TextChunk,
  ToolCallChunk,
  ReasoningChunk,
  FinishChunk,
  type AnyStreamPart,
} from "@gent/core/providers/provider"
import {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ImagePart,
} from "@gent/core/domain/message"
import type { AnyToolDefinition } from "@gent/core/domain/tool"
import { MessageId, SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"

// ── Helpers ──

const makeMsg = (role: "user" | "assistant" | "system" | "tool", parts: Message["parts"]) =>
  new Message({
    id: MessageId.make("msg-1"),
    sessionId: SessionId.make("sess-1"),
    branchId: BranchId.make("br-1"),
    role,
    parts,
    createdAt: new Date(),
  })

const tcId = ToolCallId.make("tc-1")

// ── convertMessages ──

describe("convertMessages", () => {
  test("converts system message", () => {
    const msgs = [makeMsg("system", [new TextPart({ type: "text", text: "You are helpful." })])]
    const result = convertMessages(msgs, { keychainMode: false })
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("system")
    expect(result[0]!.content).toBe("You are helpful.")
  })

  test("converts user message with text", () => {
    const msgs = [makeMsg("user", [new TextPart({ type: "text", text: "Hello" })])]
    const result = convertMessages(msgs, { keychainMode: false })
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("user")
    const parts = result[0]!.content as Prompt.UserMessagePart[]
    expect(parts[0]!.type).toBe("text")
  })

  test("converts user message with image", () => {
    const msgs = [
      makeMsg("user", [new ImagePart({ type: "image", image: "data:image/png;base64,abc" })]),
    ]
    const result = convertMessages(msgs, { keychainMode: false })
    expect(result).toHaveLength(1)
    const parts = result[0]!.content as Prompt.UserMessagePart[]
    expect(parts[0]!.type).toBe("file")
  })

  test("converts assistant message with tool call", () => {
    const msgs = [
      makeMsg("assistant", [
        new TextPart({ type: "text", text: "Let me check." }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: tcId,
          toolName: "search",
          input: { query: "test" },
        }),
      ]),
    ]
    const result = convertMessages(msgs, { keychainMode: false })
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("assistant")
    const parts = result[0]!.content as Prompt.AssistantMessagePart[]
    expect(parts).toHaveLength(2)
    expect(parts[0]!.type).toBe("text")
    expect(parts[1]!.type).toBe("tool-call")
    const tc = parts[1] as Prompt.ToolCallPart
    expect(tc.id).toBe(tcId)
    expect(tc.name).toBe("search")
    expect(tc.params).toEqual({ query: "test" })
  })

  test("converts tool result message", () => {
    const msgs = [
      makeMsg("tool", [
        new ToolResultPart({
          type: "tool-result",
          toolCallId: tcId,
          toolName: "search",
          output: { type: "json", value: { results: ["a", "b"] } },
        }),
      ]),
    ]
    const result = convertMessages(msgs, { keychainMode: false })
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("tool")
    const parts = result[0]!.content as Prompt.ToolMessagePart[]
    expect(parts[0]!.type).toBe("tool-result")
    const tr = parts[0] as Prompt.ToolResultPart
    expect(tr.isFailure).toBe(false)
    expect(tr.result).toEqual({ results: ["a", "b"] })
  })

  test("converts error tool result with isFailure=true", () => {
    const msgs = [
      makeMsg("tool", [
        new ToolResultPart({
          type: "tool-result",
          toolCallId: tcId,
          toolName: "search",
          output: { type: "error-json", value: { error: "not found" } },
        }),
      ]),
    ]
    const result = convertMessages(msgs, { keychainMode: false })
    const parts = result[0]!.content as Prompt.ToolMessagePart[]
    const tr = parts[0] as Prompt.ToolResultPart
    expect(tr.isFailure).toBe(true)
  })

  test("keychainMode adds cache control to system messages", () => {
    const msgs = [makeMsg("system", [new TextPart({ type: "text", text: "System prompt" })])]
    const result = convertMessages(msgs, { keychainMode: true })
    const sys = result[0]! as Prompt.SystemMessage
    expect(sys.options.anthropic?.cacheControl).toEqual({ type: "ephemeral" })
  })

  test("skips empty messages", () => {
    const msgs = [makeMsg("user", [])]
    const result = convertMessages(msgs, { keychainMode: false })
    expect(result).toHaveLength(0)
  })
})

// ── convertTools ──

describe("convertTools", () => {
  const EchoParams = Schema.Struct({ text: Schema.String })
  const echoDef: AnyToolDefinition = {
    name: "echo",
    action: "read",
    description: "Echoes input",
    params: EchoParams,
    execute: () => Effect.succeed("echoed"),
  }

  test("creates tools with correct names", () => {
    const result = convertTools([echoDef], { keychainMode: false })
    expect(Object.keys(result.tools)).toEqual(["echo"])
    expect(result.tools["echo"]!.name).toBe("echo")
  })

  test("keychainMode prefixes tool names with mcp_", () => {
    const result = convertTools([echoDef], { keychainMode: true })
    expect(Object.keys(result.tools)).toEqual(["mcp_echo"])
    expect(result.tools["mcp_echo"]!.name).toBe("mcp_echo")
  })

  test("creates WithHandler with handle function", () => {
    const result = convertTools([echoDef], { keychainMode: false })
    expect(typeof result.handle).toBe("function")
  })

  test("tool has json schema parameters", () => {
    const result = convertTools([echoDef], { keychainMode: false })
    const tool = result.tools["echo"]!
    // Dynamic tools have jsonSchema property
    const js = (tool as { jsonSchema?: unknown }).jsonSchema as Record<string, unknown>
    expect(js).toBeDefined()
    expect(js["type"]).toBe("object")
    expect(js["properties"]).toBeDefined()
    const props = js["properties"] as Record<string, unknown>
    expect(props["text"]).toBeDefined()
  })

  test("multiple tools", () => {
    const SearchParams = Schema.Struct({ query: Schema.String })
    const searchDef: AnyToolDefinition = {
      name: "search",
      action: "read",
      description: "Searches",
      params: SearchParams,
      execute: () => Effect.succeed("found"),
    }
    const result = convertTools([echoDef, searchDef], { keychainMode: false })
    expect(Object.keys(result.tools).sort()).toEqual(["echo", "search"])
  })
})

// ── toStreamChunk ──

describe("toStreamChunk", () => {
  const map = toStreamChunk("test/model", false)
  const mapKeychain = toStreamChunk("test/model", true)

  test("maps text-delta to TextChunk", async () => {
    const part = Response.makePart("text-delta", {
      id: "1",
      delta: "Hello",
    }) as AnyStreamPart
    const chunk = await Effect.runPromise(map(part))
    expect(chunk).toBeInstanceOf(TextChunk)
    expect((chunk as TextChunk).text).toBe("Hello")
  })

  test("maps tool-call to ToolCallChunk", async () => {
    const part = Response.makePart("tool-call", {
      id: "tc-1",
      name: "echo",
      params: { text: "hi" },
      providerExecuted: false,
    }) as AnyStreamPart
    const chunk = await Effect.runPromise(map(part))
    expect(chunk).toBeInstanceOf(ToolCallChunk)
    const tc = chunk as ToolCallChunk
    expect(tc.toolCallId).toBe("tc-1")
    expect(tc.toolName).toBe("echo")
    expect(tc.input).toEqual({ text: "hi" })
  })

  test("maps reasoning-delta to ReasoningChunk", async () => {
    const part = Response.makePart("reasoning-delta", {
      id: "1",
      delta: "thinking...",
    }) as AnyStreamPart
    const chunk = await Effect.runPromise(map(part))
    expect(chunk).toBeInstanceOf(ReasoningChunk)
    expect((chunk as ReasoningChunk).text).toBe("thinking...")
  })

  test("maps finish to FinishChunk with usage", async () => {
    const part = Response.makePart("finish", {
      reason: "stop",
      usage: {
        inputTokens: { total: 100 },
        outputTokens: { total: 50 },
      },
      response: undefined,
    }) as AnyStreamPart
    const chunk = await Effect.runPromise(map(part))
    expect(chunk).toBeInstanceOf(FinishChunk)
    const fc = chunk as FinishChunk
    expect(fc.finishReason).toBe("stop")
    expect(fc.usage?.inputTokens).toBe(100)
    expect(fc.usage?.outputTokens).toBe(50)
  })

  test("maps error to ProviderError failure", async () => {
    const part = Response.makePart("error", {
      message: "rate limited",
    }) as AnyStreamPart
    const result = await Effect.runPromiseExit(map(part))
    expect(result._tag).toBe("Failure")
  })

  test("returns null for unknown part types", async () => {
    const part = Response.makePart("text-start", { id: "1" }) as AnyStreamPart
    const chunk = await Effect.runPromise(map(part))
    expect(chunk).toBeNull()
  })

  test("strips mcp_ prefix from tool names in keychainMode", async () => {
    const part = Response.makePart("tool-call", {
      id: "tc-1",
      name: "mcp_echo",
      params: { text: "hi" },
      providerExecuted: false,
    }) as AnyStreamPart
    const chunk = await Effect.runPromise(mapKeychain(part))
    expect((chunk as ToolCallChunk).toolName).toBe("echo")
  })

  test("does not strip mcp_ prefix when not in keychainMode", async () => {
    const part = Response.makePart("tool-call", {
      id: "tc-1",
      name: "mcp_echo",
      params: {},
      providerExecuted: false,
    }) as AnyStreamPart
    const chunk = await Effect.runPromise(map(part))
    expect((chunk as ToolCallChunk).toolName).toBe("mcp_echo")
  })
})
