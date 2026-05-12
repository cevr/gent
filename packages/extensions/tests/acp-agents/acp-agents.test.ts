/**
 * ACP agents — unit tests for protocol mapping and codemode proxy.
 *
 * Tests the ACP SessionNotification → response part mapping and the
 * codemode proxy dispatch/rejection behavior.
 */
import { describe, test, expect, it } from "effect-bun-test"
import { Context, Effect, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { tool, type ToolCapability } from "@gent/core/extensions/api"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import { SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import {
  makeAcpResponsePartMapper,
  mapAcpUpdateToResponsePart,
} from "../../src/acp-agents/executor.js"
import { SessionNotification } from "../../src/acp-agents/schema.js"
import { startCodemodeServer } from "../../src/acp-agents/mcp-codemode.js"
import { makeAcpRunTool } from "../../src/acp-agents/executor-boundary.js"

// ── ACP → response part mapping ──
const makeNotification = (update: unknown) =>
  Schema.decodeUnknownSync(SessionNotification)({ sessionId: SessionId.make("s1"), update })
describe("mapAcpUpdateToResponsePart", () => {
  test("maps agent_message_chunk with text content to text-delta", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      }),
    )
    expect(part).toMatchObject({ type: "text-delta", id: "acp-text", delta: "hello world" })
  })
  test("maps agent_thought_chunk with text content to reasoning-delta", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      }),
    )
    expect(part).toMatchObject({
      type: "reasoning-delta",
      id: "acp-reasoning",
      delta: "thinking...",
    })
  })
  test("maps tool_call to tool-started", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: ToolCallId.make("tc-1"),
        title: "read_file",
      }),
    )
    expect(part).toMatchObject({
      type: "tool-call",
      id: "tc-1",
      name: "read_file",
      params: {},
      providerExecuted: false,
    })
  })
  test("maps tool_call_update completed to tool-completed", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-1"),
        status: "completed",
      }),
    )
    expect(part).toMatchObject({
      type: "tool-result",
      id: "tc-1",
      name: "external",
      result: null,
      isFailure: false,
      providerExecuted: false,
      preliminary: false,
    })
  })
  test("maps tool_call_update failed to tool-failed", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-2"),
        status: "failed",
        error: "not found",
      }),
    )
    expect(part).toMatchObject({
      type: "tool-result",
      id: "tc-2",
      name: "external",
      result: "not found",
      encodedResult: { error: "not found" },
      isFailure: true,
      providerExecuted: false,
      preliminary: false,
    })
  })
  test("captures text content blocks into tool-completed output", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-out-1"),
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "first " } },
          { type: "content", content: { type: "text", text: "second" } },
        ],
      }),
    )
    expect(part).toMatchObject({
      type: "tool-result",
      id: "tc-out-1",
      name: "external",
      result: "first second",
      encodedResult: "first second",
      isFailure: false,
    })
  })
  test("preserves a single non-text content block as structured output", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-out-2"),
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "image", data: "base64...", mimeType: "image/png" },
          },
        ],
      }),
    )
    expect(part).toMatchObject({
      type: "tool-result",
      id: "tc-out-2",
      name: "external",
      result: { type: "image", data: "base64...", mimeType: "image/png" },
      encodedResult: { type: "image", data: "base64...", mimeType: "image/png" },
      isFailure: false,
    })
  })
  test("normalizes mixed text and non-text blocks into a structured array", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-out-mixed"),
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "see image:" } },
          {
            type: "content",
            content: { type: "image", data: "base64...", mimeType: "image/png" },
          },
        ],
      }),
    )
    expect(part).toMatchObject({
      type: "tool-result",
      id: "tc-out-mixed",
      name: "external",
      result: [
        { type: "text", text: "see image:" },
        { type: "image", data: "base64...", mimeType: "image/png" },
      ],
      encodedResult: [
        { type: "text", text: "see image:" },
        { type: "image", data: "base64...", mimeType: "image/png" },
      ],
      isFailure: false,
    })
  })
  test("emits tool-completed with no output when content array is absent", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-out-3"),
        status: "completed",
      }),
    )
    expect(part).toMatchObject({
      type: "tool-result",
      id: "tc-out-3",
      name: "external",
      result: null,
      isFailure: false,
    })
  })
  test("remembers tool_call names for later tool result parts", () => {
    const mapper = makeAcpResponsePartMapper()
    mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: ToolCallId.make("tc-named"),
        title: "read_file",
      }),
      mapper,
    )
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-named"),
        status: "completed",
      }),
      mapper,
    )
    expect(part).toMatchObject({ type: "tool-result", id: "tc-named", name: "read_file" })
  })
  test("returns undefined for non-text content in message chunk", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "base64...", mimeType: "image/png" },
      }),
    )
    expect(event).toBeUndefined()
  })
  test("returns undefined for unknown session update type", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "usage_update",
        totalInputTokens: 100,
      }),
    )
    expect(event).toBeUndefined()
  })
  test("returns undefined for null update", () => {
    const event = mapAcpUpdateToResponsePart(makeNotification(null))
    expect(event).toBeUndefined()
  })
  test("tool_call without toolCallId returns undefined", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call",
        title: "bash",
      }),
    )
    expect(event).toBeUndefined()
  })
  test("tool_call uses 'unknown' when title is missing", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: ToolCallId.make("tc-3"),
      }),
    )
    expect(event).toMatchObject({
      type: "tool-call",
      id: "tc-3",
      name: "unknown",
    })
  })
  test("tool_call_update with in-progress status returns undefined", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-1"),
        status: "in_progress",
      }),
    )
    expect(event).toBeUndefined()
  })
})
// ── Codemode proxy ──
/** Parse SSE response to extract JSON-RPC result */
const JsonUnknown = Schema.fromJsonString(Schema.Unknown)
const decodeJsonUnknown = Schema.decodeUnknownEffect(JsonUnknown)
const encodeJsonUnknown = Schema.encodeSync(JsonUnknown)
const parseSseResult = (response: Response) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => response.text())
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const json = yield* decodeJsonUnknown(line.slice(6)).pipe(Effect.orDie)
        if (typeof json === "object" && json !== null && "result" in json) return json["result"]
      }
    }
    return undefined
  })
const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
}
const callMcp = (
  serverUrl: string,
  payload: {
    readonly jsonrpc: "2.0"
    readonly id: number
    readonly method: "tools/call"
    readonly params: {
      readonly name: "execute"
      readonly arguments: { readonly code: string }
    }
  },
) =>
  Bun.fetch(`${serverUrl}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: encodeJsonUnknown(payload),
  })
describe("codemode proxy", () => {
  it.scopedLive("dispatches known tool to runTool", () =>
    Effect.gen(function* () {
      const calls: Array<{
        toolName: string
        args: unknown
      }> = []
      const mockTool: ToolCapability = tool({
        id: "echo",
        description: "echo tool",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ echoed: Schema.Boolean }),
        execute: () => Effect.succeed({ echoed: true }),
      })
      const server = yield* startCodemodeServer({
        tools: [mockTool],
        runTool: (toolName, args) => {
          calls.push({ toolName, args })
          return { result: "ok" }
        },
      })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return gent.echo({ text: "hello" })' },
          },
        }),
      )
      const result = yield* parseSseResult(response)
      expect(calls.length).toBe(1)
      expect(calls[0]!.toolName).toBe("echo")
      expect(calls[0]!.args).toEqual({ text: "hello" })
      expect(result).toBeDefined()
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("rejects unknown tool in proxy", () =>
    Effect.gen(function* () {
      const server = yield* startCodemodeServer({
        tools: [],
        runTool: () => {
          throw new Error("should not be called")
        },
      })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return gent.nonexistent({ foo: "bar" })' },
          },
        }),
      )
      const result = (yield* parseSseResult(response)) as Record<string, unknown> | undefined
      expect(result?.["isError"]).toBe(true)
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
})
// ── Codemode proxy via real makeAcpRunTool boundary ──
//
// The previous block stubs `runTool` directly. This block drives the same
// dispatch through `makeAcpRunTool`, which is the boundary helper used in
// production by the ACP executor. A regression that breaks the
// Effect-runtime crossing (e.g. forgetting to thread services into
// `Effect.runPromiseWith`, or pulling ToolRunner from the wrong context)
// surfaces here and not in the stubbed test above.
describe("codemode proxy via makeAcpRunTool", () => {
  class BoundaryProbe extends Context.Service<BoundaryProbe, { readonly value: string }>()(
    "@gent/extensions/tests/acp-agents/acp-agents.test/BoundaryProbe",
  ) {}

  it.scopedLive("runs through the boundary helper and reaches core runTool", () =>
    Effect.gen(function* () {
      const calls: Array<{
        name: string
        input: unknown
      }> = []
      const runTool = makeAcpRunTool({
        services: Context.empty(),
        runTool: (toolName, input) => {
          calls.push({ name: toolName, input })
          return Effect.succeed(
            Prompt.toolResultPart({
              id: ToolCallId.make("tc-acp-boundary"),
              name: toolName,
              isFailure: false,
              result: { boundary: "ok" },
            }),
          )
        },
      })
      const mockTool: ToolCapability = tool({
        id: "echo",
        description: "echo tool",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ echoed: Schema.Boolean }),
        execute: () => Effect.succeed({ echoed: true }),
      })
      const server = yield* startCodemodeServer({ tools: [mockTool], runTool })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return gent.echo({ text: "via-boundary" })' },
          },
        }),
      )
      const result = yield* parseSseResult(response)
      expect(calls.length).toBe(1)
      expect(calls[0]!.name).toBe("echo")
      expect(calls[0]!.input).toEqual({ text: "via-boundary" })
      expect(result).toBeDefined()
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("provides required services at the runTool boundary", () =>
    Effect.gen(function* () {
      const observed: string[] = []
      const services = Context.empty().pipe(
        Context.add(BoundaryProbe, BoundaryProbe.of({ value: "from-boundary-context" })),
      )
      const runTool = makeAcpRunTool({
        services,
        runTool: (toolName) =>
          Effect.gen(function* () {
            const probe = yield* BoundaryProbe
            observed.push(probe.value)
            return Prompt.toolResultPart({
              id: ToolCallId.make("tc-acp-boundary-context"),
              name: toolName,
              isFailure: false,
              result: { boundary: probe.value },
            })
          }),
      })
      const mockTool: ToolCapability = tool({
        id: "echo",
        description: "echo tool",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ echoed: Schema.Boolean }),
        execute: () => Effect.succeed({ echoed: true }),
      })
      const server = yield* startCodemodeServer({ tools: [mockTool], runTool })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return gent.echo({ text: "needs-context" })' },
          },
        }),
      )
      const result = yield* parseSseResult(response)
      expect(result).toBeDefined()
      expect(observed).toEqual(["from-boundary-context"])
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("propagates core runTool errors back through the SDK boundary", () =>
    Effect.gen(function* () {
      const runTool = makeAcpRunTool({
        services: Context.empty(),
        runTool: () => Effect.die("tool runner exploded"),
      })
      const mockTool: ToolCapability = tool({
        id: "echo",
        description: "echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ echoed: Schema.Boolean }),
        execute: () => Effect.succeed({ echoed: true }),
      })
      const server = yield* startCodemodeServer({ tools: [mockTool], runTool })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return gent.echo({ text: "fail" })' },
          },
        }),
      )
      // Failure surfaces through the codemode SSE response as an error
      // payload, not a thrown native Error — the boundary must not let
      // the Effect die-cause crash the codemode server.
      const result = (yield* parseSseResult(response)) as Record<string, unknown> | undefined
      expect(result?.["isError"]).toBe(true)
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
})
