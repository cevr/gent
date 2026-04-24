/**
 * ACP agents — unit tests for protocol mapping and codemode proxy.
 *
 * Tests the ACP SessionNotification → TurnEvent mapping and the
 * codemode proxy dispatch/rejection behavior.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import type { AnyCapabilityContribution } from "@gent/core/domain/capability"
import {
  ReasoningDelta,
  TextDelta,
  ToolCompleted,
  ToolFailed,
  ToolStarted,
} from "@gent/core/extensions/api"
import { mapAcpUpdateToTurnEvent } from "@gent/extensions/acp-agents/executor"
import { SessionNotification } from "@gent/extensions/acp-agents/schema"
import { startCodemodeServer } from "@gent/extensions/acp-agents/mcp-codemode"

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
