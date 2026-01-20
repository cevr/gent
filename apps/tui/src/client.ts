import { Effect, Stream, Runtime } from "effect"
import type { RpcClient, RpcGroup } from "@effect/rpc"
import type { GentRpcs } from "@gent/server"
import type { AgentEvent, MessagePart, TextPart, ToolCallPart, ToolResultPart } from "@gent/core"

export type { MessagePart, TextPart, ToolCallPart, ToolResultPart }

export function extractText(parts: readonly MessagePart[]): string {
  const textPart = parts.find((p): p is TextPart => p.type === "text")
  return textPart?.text ?? ""
}

export interface ExtractedToolCall {
  id: string
  toolName: string
  status: "completed" | "error"
  input: unknown | undefined
  summary: string | undefined
  output: string | undefined
}

// Stringify tool output to full string
function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

// Summarize tool output for display - truncate long strings and format objects
function summarizeOutput(output: { type: "json" | "error-json"; value: unknown }): string {
  const value = output.value
  if (typeof value === "string") {
    const firstLine = value.split("\n")[0] ?? ""
    // Limit to 100 characters to prevent UI overflow
    return firstLine.length > 100 ? firstLine.slice(0, 100) + "..." : firstLine
  }
  if (value && typeof value === "object") {
    const str = JSON.stringify(value)
    return str.length > 100 ? str.slice(0, 100) + "..." : str
  }
  return String(value)
}

// Extract tool calls from a single message's parts (no result joining)
export function extractToolCalls(parts: readonly MessagePart[]): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => ({
      id: tc.toolCallId,
      toolName: tc.toolName,
      status: "completed" as const,
      input: tc.input,
      summary: undefined,
      output: undefined,
    }))
}

// Build tool result map from all messages for joining
export function buildToolResultMap(
  messages: readonly MessageInfoReadonly[],
): Map<string, { summary: string; output: string; isError: boolean }> {
  const resultMap = new Map<string, { summary: string; output: string; isError: boolean }>()

  for (const msg of messages) {
    if (msg.role === "tool") {
      for (const part of msg.parts) {
        if (part.type === "tool-result") {
          const result = part as ToolResultPart
          resultMap.set(result.toolCallId, {
            summary: summarizeOutput(result.output),
            output: stringifyOutput(result.output.value),
            isError: result.output.type === "error-json",
          })
        }
      }
    }
  }

  return resultMap
}

// Extract tool calls with results joined from result map
export function extractToolCallsWithResults(
  parts: readonly MessagePart[],
  resultMap: Map<string, { summary: string; output: string; isError: boolean }>,
): ExtractedToolCall[] {
  return parts
    .filter((p): p is ToolCallPart => p.type === "tool-call")
    .map((tc) => {
      const result = resultMap.get(tc.toolCallId)
      return {
        id: tc.toolCallId,
        toolName: tc.toolName,
        status: result?.isError ? ("error" as const) : ("completed" as const),
        input: tc.input,
        summary: result?.summary,
        output: result?.output,
      }
    })
}

// RPC client type from GentRpcs
export type GentRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof GentRpcs>>

// Message type returned from RPC (readonly)
export interface MessageInfoReadonly {
  readonly id: string
  readonly sessionId: string
  readonly branchId: string
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly parts: readonly MessagePart[]
  readonly createdAt: number
  readonly turnDurationMs: number | undefined
}

// Steer command types
export type SteerCommand =
  | { _tag: "Cancel" }
  | { _tag: "Interrupt"; message: string }
  | { _tag: "SwitchModel"; model: string }
  | { _tag: "SwitchMode"; mode: "build" | "plan" }

// GentClient interface - adapts RPC client to callback-based subscriptions
export interface GentClient {
  sendMessage: (input: { sessionId: string; branchId: string; content: string }) => Promise<void>

  listMessages: (branchId: string) => Promise<readonly MessageInfoReadonly[]>

  subscribeEvents: (sessionId: string, onEvent: (event: AgentEvent) => void) => () => void

  steer: (command: SteerCommand) => Promise<void>
}

/**
 * Creates a GentClient from an RPC client.
 * Uses provided runtime for all Effect execution.
 * RPC methods return Effect<T, E, never> so runtime context is unused.
 */
export function createClient(
  rpcClient: GentRpcClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime context unused by RPC calls
  runtime: Runtime.Runtime<any>,
): GentClient {
  return {
    sendMessage: (input) =>
      Runtime.runPromise(runtime)(rpcClient.sendMessage(input)).catch((err) => {
        console.error("sendMessage error:", err)
        throw err
      }),

    listMessages: (branchId) =>
      Runtime.runPromise(runtime)(rpcClient.listMessages({ branchId })) as Promise<
        readonly MessageInfoReadonly[]
      >,

    steer: (command) => Runtime.runPromise(runtime)(rpcClient.steer({ command })),

    subscribeEvents: (sessionId, onEvent) => {
      let cancelled = false

      // subscribeEvents returns a Stream directly (not Effect<Stream>)
      const events = rpcClient.subscribeEvents({ sessionId })

      // Run the stream
      const streamEffect = Stream.runForEach(events, (event: AgentEvent) =>
        Effect.sync(() => {
          if (!cancelled) {
            onEvent(event)
          }
        }),
      )

      void Runtime.runPromise(runtime)(streamEffect).catch(() => {
        // Stream ended or cancelled
      })

      return () => {
        cancelled = true
      }
    },
  }
}
