/**
 * ACP agents — unit tests for protocol mapping and the cell-backed codemode server.
 *
 * Tests the ACP SessionNotification → response part mapping and the
 * codemode `execute` forwarding into the branch cell.
 */
import { describe, test, expect, it } from "effect-bun-test"
import { Context, Effect, Option, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { InteractionPendingError, tool, type ToolCapability } from "@gent/core/extensions/api"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import {
  BranchId,
  InteractionRequestId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import {
  makeAcpResponsePartMapper,
  mapAcpUpdateToResponsePart,
} from "../../src/acp-agents/executor.js"
import { SessionNotification } from "../../src/acp-agents/schema.js"
import { startCodemodeServer } from "../../src/acp-agents/mcp-codemode.js"
import { makeAcpRunTool } from "../../src/acp-agents/executor-boundary.js"
import { externalWireNull } from "../helpers/external-wire.js"

// ── ACP → response part mapping ──
const makeNotification = (update: SessionNotification["update"]) =>
  Schema.decodeSync(SessionNotification)({
    sessionId: SessionId.make("s1"),
    update,
  })
describe("mapAcpUpdateToResponsePart", () => {
  test("maps agent_message_chunk with text content to text-delta", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      }),
    )
    expect(Option.getOrThrow(part)).toMatchObject({
      type: "text-delta",
      id: "acp-text",
      delta: "hello world",
    })
  })
  test("maps agent_thought_chunk with text content to reasoning-delta", () => {
    const part = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      }),
    )
    expect(Option.getOrThrow(part)).toMatchObject({
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
    expect(Option.getOrThrow(part)).toMatchObject({
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
    expect(Option.getOrThrow(part)).toMatchObject({
      type: "tool-result",
      id: "tc-1",
      name: "external",
      result: externalWireNull,
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
    expect(Option.getOrThrow(part)).toMatchObject({
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
    expect(Option.getOrThrow(part)).toMatchObject({
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
            content: {
              type: "image",
              data: "base64...",
              mimeType: "image/png",
            },
          },
        ],
      }),
    )
    expect(Option.getOrThrow(part)).toMatchObject({
      type: "tool-result",
      id: "tc-out-2",
      name: "external",
      result: { type: "image", data: "base64...", mimeType: "image/png" },
      encodedResult: {
        type: "image",
        data: "base64...",
        mimeType: "image/png",
      },
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
            content: {
              type: "image",
              data: "base64...",
              mimeType: "image/png",
            },
          },
        ],
      }),
    )
    expect(Option.getOrThrow(part)).toMatchObject({
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
    expect(Option.getOrThrow(part)).toMatchObject({
      type: "tool-result",
      id: "tc-out-3",
      name: "external",
      result: externalWireNull,
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
    expect(Option.getOrThrow(part)).toMatchObject({
      type: "tool-result",
      id: "tc-named",
      name: "read_file",
    })
  })
  test("returns None for non-text content in message chunk", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "base64...", mimeType: "image/png" },
      }),
    )
    expect(Option.isNone(event)).toBe(true)
  })
  test("returns None for unknown session update type", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "usage_update",
        totalInputTokens: 100,
      }),
    )
    expect(Option.isNone(event)).toBe(true)
  })
  test("returns None for null update", () => {
    const event = mapAcpUpdateToResponsePart(makeNotification(externalWireNull))
    expect(Option.isNone(event)).toBe(true)
  })
  test("tool_call without toolCallId returns None", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call",
        title: "bash",
      }),
    )
    expect(Option.isNone(event)).toBe(true)
  })
  test("tool_call uses 'unknown' when title is missing", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: ToolCallId.make("tc-3"),
      }),
    )
    expect(Option.getOrThrow(event)).toMatchObject({
      type: "tool-call",
      id: "tc-3",
      name: "unknown",
    })
  })
  test("tool_call_update with in-progress status returns None", () => {
    const event = mapAcpUpdateToResponsePart(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: ToolCallId.make("tc-1"),
        status: "in_progress",
      }),
    )
    expect(Option.isNone(event)).toBe(true)
  })
})
// ── Codemode proxy ──
/** Parse SSE response to extract JSON-RPC result */
const JsonUnknown = Schema.fromJsonString(Schema.Unknown)
const decodeJsonUnknown = Schema.decodeUnknownEffect(JsonUnknown)
const encodeJsonUnknown = Schema.encodeSync(JsonUnknown)
const ErrorResult = Schema.Struct({ isError: Schema.Boolean })
const assertErrorResult = (result: Option.Option<unknown>) => {
  const decoded = Option.flatMap(result, Schema.decodeUnknownOption(ErrorResult))
  expect(Option.isSome(decoded)).toBe(true)
  if (Option.isSome(decoded)) expect(decoded.value.isError).toBe(true)
}
const parseSseResult = (response: Response) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => response.text())
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const json = yield* decodeJsonUnknown(line.slice(6)).pipe(Effect.orDie)
        if (Schema.is(Schema.Record(Schema.String, Schema.Unknown))(json) && "result" in json) {
          return Option.some(json["result"])
        }
      }
    }
    return yield* Effect.die(
      new Error(
        `MCP response did not include a JSON-RPC result (HTTP ${response.status} ${response.statusText}): ${text}`,
      ),
    )
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
class BoundaryProbe extends Context.Service<BoundaryProbe, { readonly value: string }>()(
  "@gent/extensions/tests/acp-agents/acp-agents.test/BoundaryProbe",
) {}
describe("codemode execute", () => {
  it.scopedLive("forwards the code to the branch cell tool", () =>
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
            arguments: {
              code: "await tools.call('echo', { text: \"hello\" })",
            },
          },
        }),
      )
      const result = yield* parseSseResult(response)
      expect(calls.length).toBe(1)
      expect(calls[0]!.toolName).toBe("cell")
      expect(calls[0]!.args).toEqual({
        code: "await tools.call('echo', { text: \"hello\" })",
      })
      expect(Option.isSome(result)).toBe(true)
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("refreshes runTool authority without restarting the codemode server", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const mockTool: ToolCapability = tool({
        id: "echo",
        description: "echo tool",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ echoed: Schema.Boolean }),
        execute: () => Effect.succeed({ echoed: true }),
      })
      const server = yield* startCodemodeServer({
        tools: [mockTool],
        runTool: () => {
          calls.push("first")
          return { result: "first" }
        },
      })

      const callEcho = () =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: "await tools.call('echo', { text: \"hello\" })",
            },
          },
        })

      yield* Effect.promise(callEcho).pipe(Effect.flatMap(parseSseResult))
      yield* server.updateConfig({
        tools: [mockTool],
        runTool: () => {
          calls.push("second")
          return { result: "second" }
        },
      })
      yield* Effect.promise(callEcho).pipe(Effect.flatMap(parseSseResult))

      expect(calls).toEqual(["first", "second"])
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("reports a failed cell result as an MCP error", () =>
    Effect.gen(function* () {
      const server = yield* startCodemodeServer({
        tools: [],
        runTool: () =>
          Prompt.toolResultPart({
            id: ToolCallId.make("unused"),
            name: "unused",
            isFailure: true,
            providerExecuted: false,
            result: externalWireNull,
          }),
      })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: "await tools.call('nonexistent', { foo: \"bar\" })",
            },
          },
        }),
      )
      assertErrorResult(yield* parseSseResult(response))
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
})
// ── Codemode execute via real makeAcpRunTool boundary ──
//
// The previous block stubs `runTool` directly. This block drives the same
// dispatch through `makeAcpRunTool`, which is the boundary helper used in
// production by the ACP executor. A regression that breaks the
// Effect-runtime crossing (e.g. leaking Effect requirements into the
// Promise boundary, or pulling ToolRunner from the wrong context)
// surfaces here and not in the stubbed test above.
describe("codemode execute via makeAcpRunTool", () => {
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
              providerExecuted: false,
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
      const server = yield* startCodemodeServer({
        tools: [mockTool],
        runTool,
      })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: "await tools.call('echo', { text: \"via-boundary\" })",
            },
          },
        }),
      )
      const result = yield* parseSseResult(response)
      expect(calls.length).toBe(1)
      expect(calls[0]!.name).toBe("cell")
      expect(calls[0]!.input).toEqual({
        code: "await tools.call('echo', { text: \"via-boundary\" })",
      })
      expect(Option.isSome(result)).toBe(true)
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("runs the tool effect with the turn's captured services", () =>
    Effect.gen(function* () {
      const observed: string[] = []
      const runTool = makeAcpRunTool({
        services: Context.make(BoundaryProbe, {
          value: "from-boundary-service",
        }),
        runTool: (toolName) =>
          Effect.gen(function* () {
            const probe = yield* Effect.serviceOption(BoundaryProbe)
            observed.push(
              Option.map(probe, (service) => service.value).pipe(Option.getOrElse(() => "missing")),
            )
            return Prompt.toolResultPart({
              id: ToolCallId.make("tc-acp-boundary-context"),
              name: toolName,
              isFailure: false,
              providerExecuted: false,
              result: { boundary: "ok" },
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
            arguments: {
              code: "await tools.call('echo', { text: \"needs-context\" })",
            },
          },
        }),
      )
      const result = yield* parseSseResult(response)
      expect(Option.isSome(result)).toBe(true)
      expect(observed).toEqual(["from-boundary-service"])
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
      const server = yield* startCodemodeServer({
        tools: [mockTool],
        runTool,
      })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: "await tools.call('echo', { text: \"fail\" })",
            },
          },
        }),
      )
      // Failure surfaces through the codemode SSE response as an error
      // payload, not a thrown native Error — the boundary must not let
      // the Effect die-cause crash the codemode server.
      assertErrorResult(yield* parseSseResult(response))
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("notifies the turn executor when an interaction parks at the boundary", () =>
    Effect.gen(function* () {
      const pending = new InteractionPendingError({
        requestId: InteractionRequestId.make("req-acp-boundary"),
        sessionId: SessionId.make("s-acp-boundary"),
        branchId: BranchId.make("b-acp-boundary"),
      })
      const observed: InteractionPendingError[] = []
      const runTool = makeAcpRunTool({
        services: Context.empty(),
        runTool: () => Effect.fail(pending),
      })
      const mockTool: ToolCapability = tool({
        id: "echo",
        description: "echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ echoed: Schema.Boolean }),
        execute: () => Effect.succeed({ echoed: true }),
      })
      const server = yield* startCodemodeServer({
        tools: [mockTool],
        runTool,
        onInteractionPending: (error) => {
          observed.push(error)
        },
      })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: "await tools.call('echo', { text: \"park\" })",
            },
          },
        }),
      )
      assertErrorResult(yield* parseSseResult(response))
      expect(observed).toEqual([pending])
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
  it.scopedLive("preserves a synchronously thrown pending error at the boundary", () =>
    Effect.gen(function* () {
      const pending = new InteractionPendingError({
        requestId: InteractionRequestId.make("req-acp-sync-boundary"),
        sessionId: SessionId.make("s-acp-sync-boundary"),
        branchId: BranchId.make("b-acp-sync-boundary"),
      })
      const observed: InteractionPendingError[] = []
      const mockTool: ToolCapability = tool({
        id: "echo",
        description: "echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ echoed: Schema.Boolean }),
        execute: () => Effect.succeed({ echoed: true }),
      })
      const server = yield* startCodemodeServer({
        tools: [mockTool],
        runTool: () => {
          // oxlint-disable-next-line effect/noThrowStatement -- exercise the synchronous host boundary
          throw pending
        },
        onInteractionPending: (error) => {
          observed.push(error)
        },
      })
      const response = yield* Effect.promise(() =>
        callMcp(server.url, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: {
              code: "await tools.call('echo', { text: \"sync-park\" })",
            },
          },
        }),
      )
      assertErrorResult(yield* parseSseResult(response))
      expect(observed[0]).toBe(pending)
    }).pipe(Effect.provide(BunGentPlatformLive)),
  )
})
