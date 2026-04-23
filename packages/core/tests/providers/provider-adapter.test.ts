import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import type { AnyCapabilityContribution } from "@gent/core/domain/capability"
import { Finished, ReasoningDelta, TextDelta, ToolCall } from "@gent/core/domain/driver"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import {
  convertMessages,
  convertTools,
  toTurnEvent,
  type ProviderStreamPart,
} from "@gent/core/providers/provider"
import {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ImagePart,
} from "@gent/core/domain/message"
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
    const result = convertMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("system")
    expect(result[0]!.content).toBe("You are helpful.")
  })

  test("converts user message with text", () => {
    const msgs = [makeMsg("user", [new TextPart({ type: "text", text: "Hello" })])]
    const result = convertMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBe("user")
    const parts = result[0]!.content as Prompt.UserMessagePart[]
    expect(parts[0]!.type).toBe("text")
  })

  test("converts user message with image", () => {
    const msgs = [
      makeMsg("user", [new ImagePart({ type: "image", image: "data:image/png;base64,abc" })]),
    ]
    const result = convertMessages(msgs)
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
    const result = convertMessages(msgs)
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
    const result = convertMessages(msgs)
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
    const result = convertMessages(msgs)
    const parts = result[0]!.content as Prompt.ToolMessagePart[]
    const tr = parts[0] as Prompt.ToolResultPart
    expect(tr.isFailure).toBe(true)
  })

  test("skips empty messages", () => {
    const msgs = [makeMsg("user", [])]
    const result = convertMessages(msgs)
    expect(result).toHaveLength(0)
  })
})

// ── convertTools ──

describe("convertTools", () => {
  const EchoParams = Schema.Struct({ text: Schema.String })
  const echoDef: AnyCapabilityContribution = {
    id: "echo",
    description: "Echoes input",
    audiences: ["model"],
    intent: "write",
    input: EchoParams,
    output: Schema.Unknown,
    effect: () => Effect.succeed("echoed"),
  }

  test("creates tools with correct names", () => {
    const result = convertTools([echoDef])
    expect(Object.keys(result.tools)).toEqual(["echo"])
    expect(result.tools["echo"]!.name).toBe("echo")
  })

  test("creates WithHandler with handle function", () => {
    const result = convertTools([echoDef])
    expect(typeof result.handle).toBe("function")
  })

  test("tool has json schema parameters", () => {
    const result = convertTools([echoDef])
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
    const searchDef: AnyCapabilityContribution = {
      id: "search",
      description: "Searches",
      audiences: ["model"],
      intent: "write",
      input: SearchParams,
      output: Schema.Unknown,
      effect: () => Effect.succeed("found"),
    }
    const result = convertTools([echoDef, searchDef])
    expect(Object.keys(result.tools).sort()).toEqual(["echo", "search"])
  })
})

// ── toTurnEvent ──

describe("toTurnEvent", () => {
  const map = toTurnEvent("test/model")

  test("maps text-delta to TextDelta", async () => {
    const part = Response.makePart("text-delta", {
      id: "1",
      delta: "Hello",
    }) satisfies ProviderStreamPart
    const event = await Effect.runPromise(map(part))
    expect(event).toBeInstanceOf(TextDelta)
    expect(event).toEqual(expect.objectContaining({ _tag: "text-delta", text: "Hello" }))
  })

  test("maps tool-call to ToolCall", async () => {
    const part = Response.makePart("tool-call", {
      id: "tc-1",
      name: "echo",
      params: { text: "hi" },
      providerExecuted: false,
    }) satisfies ProviderStreamPart
    const event = await Effect.runPromise(map(part))
    expect(event).toBeInstanceOf(ToolCall)
    expect(event).toEqual(
      expect.objectContaining({
        _tag: "tool-call",
        toolCallId: "tc-1",
        toolName: "echo",
        input: { text: "hi" },
      }),
    )
  })

  test("maps reasoning-delta to ReasoningDelta", async () => {
    const part = Response.makePart("reasoning-delta", {
      id: "1",
      delta: "thinking...",
    }) satisfies ProviderStreamPart
    const event = await Effect.runPromise(map(part))
    expect(event).toBeInstanceOf(ReasoningDelta)
    expect(event).toEqual(expect.objectContaining({ _tag: "reasoning-delta", text: "thinking..." }))
  })

  test("maps finish to Finished with usage", async () => {
    const part = Response.makePart("finish", {
      reason: "stop",
      usage: {
        inputTokens: { total: 100 },
        outputTokens: { total: 50 },
      },
      response: undefined,
    }) satisfies ProviderStreamPart
    const event = await Effect.runPromise(map(part))
    expect(event).toBeInstanceOf(Finished)
    expect(event).toEqual(
      expect.objectContaining({
        _tag: "finished",
        stopReason: "stop",
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    )
  })

  test("preserves omitted usage as undefined", async () => {
    const part = Response.makePart("finish", {
      reason: "stop",
      usage: new Response.Usage({
        inputTokens: {
          uncached: undefined,
          total: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: undefined,
          text: undefined,
          reasoning: undefined,
        },
      }),
      response: undefined,
    }) satisfies ProviderStreamPart
    const event = await Effect.runPromise(map(part))
    expect(event).toBeInstanceOf(Finished)
    expect(event).toEqual(expect.not.objectContaining({ usage: expect.anything() }))
  })

  test("maps error to ProviderError failure", async () => {
    const part = Response.makePart("error", {
      message: "rate limited",
    }) satisfies ProviderStreamPart
    const result = await Effect.runPromiseExit(map(part))
    expect(result._tag).toBe("Failure")
  })

  test("returns undefined for non-turn stream parts", async () => {
    const part = Response.makePart("text-start", { id: "1" }) satisfies ProviderStreamPart
    const event = await Effect.runPromise(map(part))
    expect(event).toBeUndefined()
  })

  test("passes through tool names as-is (no mcp_ stripping)", async () => {
    const part = Response.makePart("tool-call", {
      id: "tc-1",
      name: "mcp_echo",
      params: {},
      providerExecuted: false,
    }) satisfies ProviderStreamPart
    const event = await Effect.runPromise(map(part))
    expect(event).toEqual(expect.objectContaining({ _tag: "tool-call", toolName: "mcp_echo" }))
  })
})
