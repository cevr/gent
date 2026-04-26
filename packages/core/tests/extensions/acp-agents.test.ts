/**
 * ACP agents — unit tests for protocol mapping and codemode proxy.
 *
 * Tests the ACP SessionNotification → TurnEvent mapping and the
 * codemode proxy dispatch/rejection behavior.
 */
import { describe, test, expect } from "bun:test"
import { Context, Effect, Schema } from "effect"
import type { AnyCapabilityContribution } from "@gent/core/domain/capability"
import {
  ReasoningDelta,
  TextDelta,
  ToolCompleted,
  ToolFailed,
  ToolStarted,
} from "@gent/core/extensions/api"
import { ToolRunner } from "../../src/extensions/internal.js"
import { ToolResultPart } from "../../src/domain/message.js"
import { BranchId, SessionId, type ToolCallId } from "../../src/domain/ids.js"
import type { ExtensionHostContext } from "../../src/domain/extension-host-context.js"
import type { ToolContext } from "../../src/domain/tool.js"
import { mapAcpUpdateToTurnEvent } from "@gent/extensions/acp-agents/executor"
import { SessionNotification } from "@gent/extensions/acp-agents/schema"
import { startCodemodeServer } from "@gent/extensions/acp-agents/mcp-codemode"
import { makeAcpRunTool } from "../../../extensions/src/acp-agents/executor-boundary.js"

// ── ACP → TurnEvent mapping ──

const makeNotification = (update: unknown) =>
  Schema.decodeUnknownSync(SessionNotification)({ sessionId: "s1", update })

describe("mapAcpUpdateToTurnEvent", () => {
  test("maps agent_message_chunk with text content to text-delta", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      }),
    )
    expect(event).toEqual({ _tag: "text-delta", text: "hello world" })
    expect(event).toBeInstanceOf(TextDelta)
  })

  test("maps agent_thought_chunk with text content to reasoning-delta", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      }),
    )
    expect(event).toEqual({ _tag: "reasoning-delta", text: "thinking..." })
    expect(event).toBeInstanceOf(ReasoningDelta)
  })

  test("maps tool_call to tool-started", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "read_file",
      }),
    )
    expect(event).toEqual({ _tag: "tool-started", toolCallId: "tc-1", toolName: "read_file" })
    expect(event).toBeInstanceOf(ToolStarted)
  })

  test("maps tool_call_update completed to tool-completed", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
      }),
    )
    expect(event).toEqual({ _tag: "tool-completed", toolCallId: "tc-1" })
    expect(event).toBeInstanceOf(ToolCompleted)
  })

  test("maps tool_call_update failed to tool-failed", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-2",
        status: "failed",
        error: "not found",
      }),
    )
    expect(event).toEqual({ _tag: "tool-failed", toolCallId: "tc-2", error: "not found" })
    expect(event).toBeInstanceOf(ToolFailed)
  })

  test("captures text content blocks into tool-completed output", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-out-1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "first " } },
          { type: "content", content: { type: "text", text: "second" } },
        ],
      }),
    )
    expect(event).toEqual({
      _tag: "tool-completed",
      toolCallId: "tc-out-1",
      output: "first second",
    })
    expect(event).toBeInstanceOf(ToolCompleted)
  })

  test("preserves a single non-text content block as structured output", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-out-2",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "image", data: "base64...", mimeType: "image/png" },
          },
        ],
      }),
    )
    expect(event).toEqual({
      _tag: "tool-completed",
      toolCallId: "tc-out-2",
      output: { type: "image", data: "base64...", mimeType: "image/png" },
    })
  })

  test("emits tool-completed with no output when content array is absent", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-out-3",
        status: "completed",
      }),
    )
    expect(event).toEqual({ _tag: "tool-completed", toolCallId: "tc-out-3" })
    expect(event).toBeInstanceOf(ToolCompleted)
  })

  test("returns undefined for non-text content in message chunk", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "base64...", mimeType: "image/png" },
      }),
    )
    expect(event).toBeUndefined()
  })

  test("returns undefined for unknown session update type", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "usage_update",
        totalInputTokens: 100,
      }),
    )
    expect(event).toBeUndefined()
  })

  test("returns undefined for null update", () => {
    const event = mapAcpUpdateToTurnEvent(makeNotification(null))
    expect(event).toBeUndefined()
  })

  test("tool_call without toolCallId returns undefined", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call",
        title: "bash",
      }),
    )
    expect(event).toBeUndefined()
  })

  test("tool_call uses 'unknown' when title is missing", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call",
        toolCallId: "tc-3",
      }),
    )
    expect(event).toEqual({ _tag: "tool-started", toolCallId: "tc-3", toolName: "unknown" })
    expect(event).toBeInstanceOf(ToolStarted)
  })

  test("tool_call_update with in-progress status returns undefined", () => {
    const event = mapAcpUpdateToTurnEvent(
      makeNotification({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "in_progress",
      }),
    )
    expect(event).toBeUndefined()
  })
})

// ── Codemode proxy ──

/** Parse SSE response to extract JSON-RPC result */
const parseSseResult = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const json = JSON.parse(line.slice(6)) as Record<string, unknown>
      if ("result" in json) return json["result"]
    }
  }
  return undefined
}

const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
}

describe("codemode proxy", () => {
  test("dispatches known tool to runTool", async () => {
    const calls: Array<{ toolName: string; args: unknown }> = []

    const mockTool: AnyCapabilityContribution = {
      id: "echo",
      description: "echo tool",
      audiences: ["model"],
      intent: "write",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Unknown,
      effect: () => Effect.succeed({ echoed: true }),
    }

    const server = await Effect.runPromise(
      startCodemodeServer({
        tools: [mockTool],
        runTool: async (toolName, args) => {
          calls.push({ toolName, args })
          return { result: "ok" }
        },
      }),
    )

    try {
      const response = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return await gent.echo({ text: "hello" })' },
          },
        }),
      })

      const result = await parseSseResult(response)

      expect(calls.length).toBe(1)
      expect(calls[0]!.toolName).toBe("echo")
      expect(calls[0]!.args).toEqual({ text: "hello" })
      expect(result).toBeDefined()
    } finally {
      server.stop()
    }
  })

  test("rejects unknown tool in proxy", async () => {
    const server = await Effect.runPromise(
      startCodemodeServer({
        tools: [],
        runTool: async () => {
          throw new Error("should not be called")
        },
      }),
    )

    try {
      const response = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return await gent.nonexistent({ foo: "bar" })' },
          },
        }),
      })

      const result = (await parseSseResult(response)) as Record<string, unknown> | undefined
      expect(result?.["isError"]).toBe(true)
    } finally {
      server.stop()
    }
  })
})

// ── Codemode proxy via real makeAcpRunTool boundary ──
//
// The previous block stubs `runTool` directly. This block drives the same
// dispatch through `makeAcpRunTool`, which is the boundary helper used in
// production by the ACP executor. A regression that breaks the
// Effect-runtime crossing (e.g. forgetting to thread services into
// `Effect.runPromiseWith`, or pulling ToolRunner from the wrong context)
// surfaces here and not in the stubbed test above.

const makeStubHostCtx = (): Omit<ToolContext, "toolCallId"> => ({
  sessionId: SessionId.make("ses-acp-boundary-test"),
  branchId: BranchId.make("br-acp-boundary-test"),
  cwd: "/tmp/gent-acp-boundary-test",
  home: "/tmp/gent-acp-boundary-test-home",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: facets are not invoked by makeAcpRunTool
  extension: {} as ExtensionHostContext["extension"],
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub
  agent: {} as ExtensionHostContext["agent"],
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub
  session: {} as ExtensionHostContext["session"],
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub
  interaction: {} as ExtensionHostContext["interaction"],
})

describe("codemode proxy via makeAcpRunTool", () => {
  test("runs through the boundary helper and reaches ToolRunner", async () => {
    const calls: Array<{ toolCallId: ToolCallId; toolName: string; input: unknown }> = []

    const recordingToolRunner = ToolRunner.of({
      run: (toolCall) => {
        calls.push({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        })
        return Effect.succeed(
          new ToolResultPart({
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: { type: "json", value: { boundary: "ok" } },
          }),
        )
      },
    })

    const services = Context.make(
      ToolRunner,
      recordingToolRunner,
    ) as unknown as Context.Context<never>
    const runTool = makeAcpRunTool({ services, hostCtx: makeStubHostCtx() })

    const mockTool: AnyCapabilityContribution = {
      id: "echo",
      description: "echo tool",
      audiences: ["model"],
      intent: "write",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Unknown,
      effect: () => Effect.succeed({ echoed: true }),
    }

    const server = await Effect.runPromise(startCodemodeServer({ tools: [mockTool], runTool }))

    try {
      const response = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return await gent.echo({ text: "via-boundary" })' },
          },
        }),
      })

      const result = await parseSseResult(response)

      expect(calls.length).toBe(1)
      expect(calls[0]!.toolName).toBe("echo")
      expect(calls[0]!.input).toEqual({ text: "via-boundary" })
      // Each invocation generates a fresh toolCallId via crypto.randomUUID().
      expect(typeof calls[0]!.toolCallId).toBe("string")
      expect(calls[0]!.toolCallId.length).toBeGreaterThan(0)
      expect(result).toBeDefined()
    } finally {
      server.stop()
    }
  })

  test("propagates ToolRunner errors back through the SDK boundary", async () => {
    const failingToolRunner = ToolRunner.of({
      run: () => Effect.die(new Error("tool runner exploded")),
    })

    const services = Context.make(
      ToolRunner,
      failingToolRunner,
    ) as unknown as Context.Context<never>
    const runTool = makeAcpRunTool({ services, hostCtx: makeStubHostCtx() })

    const mockTool: AnyCapabilityContribution = {
      id: "echo",
      description: "echo",
      audiences: ["model"],
      intent: "write",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Unknown,
      effect: () => Effect.succeed({ echoed: true }),
    }

    const server = await Effect.runPromise(startCodemodeServer({ tools: [mockTool], runTool }))

    try {
      const response = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: { code: 'return await gent.echo({ text: "fail" })' },
          },
        }),
      })

      // Failure surfaces through the codemode SSE response as an error
      // payload, not a thrown native Error — the boundary must not let
      // the Effect die-cause crash the codemode server.
      const result = (await parseSseResult(response)) as Record<string, unknown> | undefined
      expect(result?.["isError"]).toBe(true)
    } finally {
      server.stop()
    }
  })
})
