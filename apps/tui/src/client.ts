import { Effect } from "effect"
import type { Stream, Runtime } from "effect"
import type { RpcClient, RpcGroup } from "@effect/rpc"
import type { GentRpcs, GentRpcError } from "@gent/server"
import type {
  AgentMode,
  EventEnvelope,
  MessagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  PermissionDecision,
  PlanDecision,
} from "@gent/core"

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
  readonly turnDurationMs?: number
}

// Steer command types
export type SteerCommand =
  | { _tag: "Cancel" }
  | { _tag: "Interrupt" }
  | { _tag: "Interject"; message: string }
  | { _tag: "SwitchModel"; model: string }
  | { _tag: "SwitchMode"; mode: "build" | "plan" }

// Session info (minimal for client)
export interface SessionInfo {
  id: string
  name?: string
  cwd?: string
  branchId?: string
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: string
  sessionId: string
  name?: string
  model?: string
  createdAt: number
}

export interface SessionState {
  sessionId: string
  branchId: string
  messages: readonly MessageInfoReadonly[]
  lastEventId: number | null
  isStreaming: boolean
  mode: AgentMode
  model?: string
}

export interface CreateSessionResult {
  sessionId: string
  branchId: string
  name: string
}

// =============================================================================
// GentClient - Returns Effects for all operations
// =============================================================================

export interface GentClient {
  /** Send a message to active session */
  sendMessage: (input: {
    sessionId: string
    branchId: string
    content: string
    mode?: AgentMode
    model?: string
  }) => Effect.Effect<void, GentRpcError>

  /** Create a new session */
  createSession: (input?: {
    firstMessage?: string
    cwd?: string
  }) => Effect.Effect<CreateSessionResult, GentRpcError>

  /** List messages for a branch */
  listMessages: (branchId: string) => Effect.Effect<readonly MessageInfoReadonly[], GentRpcError>

  /** Get session state snapshot */
  getSessionState: (input: {
    sessionId: string
    branchId: string
  }) => Effect.Effect<SessionState, GentRpcError>

  /** List all sessions */
  listSessions: () => Effect.Effect<readonly SessionInfo[], GentRpcError>

  /** List branches for a session */
  listBranches: (sessionId: string) => Effect.Effect<readonly BranchInfo[], GentRpcError>

  /** Create a new branch */
  createBranch: (sessionId: string, name?: string) => Effect.Effect<string, GentRpcError>

  /** Subscribe to events - returns Stream */
  subscribeEvents: (input: {
    sessionId: string
    branchId?: string
    after?: number
  }) => Stream.Stream<EventEnvelope, GentRpcError>

  /** Send steering command */
  steer: (command: SteerCommand) => Effect.Effect<void, GentRpcError>

  /** Respond to questions from agent */
  respondQuestions: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void, GentRpcError>

  /** Respond to permission request */
  respondPermission: (
    requestId: string,
    decision: PermissionDecision,
  ) => Effect.Effect<void, GentRpcError>

  /** Respond to plan prompt */
  respondPlan: (
    requestId: string,
    decision: PlanDecision,
    reason?: string,
  ) => Effect.Effect<void, GentRpcError>

  /** Get the runtime for this client */
  runtime: Runtime.Runtime<unknown>
}

/**
 * Creates a GentClient from an RPC client.
 * Returns Effects for all operations - caller decides how to run.
 */
export function createClient(
  rpcClient: GentRpcClient,
  runtime: Runtime.Runtime<unknown>,
): GentClient {
  return {
    sendMessage: (input) => rpcClient.sendMessage(input),

    createSession: (input) =>
      rpcClient.createSession(input ?? {}).pipe(
        Effect.map((result) => ({
          sessionId: result.sessionId,
          branchId: result.branchId,
          name: result.name,
        })),
      ),

    listMessages: (branchId) => rpcClient.listMessages({ branchId }),

    getSessionState: (input) =>
      rpcClient.getSessionState({ sessionId: input.sessionId, branchId: input.branchId }),

    listSessions: () => rpcClient.listSessions(),

    listBranches: (sessionId) => rpcClient.listBranches({ sessionId }),

    createBranch: (sessionId, name) =>
      rpcClient.createBranch({ sessionId, ...(name !== undefined ? { name } : {}) }).pipe(
        Effect.map((result) => result.branchId),
      ),

    subscribeEvents: ({ sessionId, branchId, after }) =>
      rpcClient.subscribeEvents({
        sessionId,
        ...(branchId !== undefined ? { branchId } : {}),
        ...(after !== undefined ? { after } : {}),
      }),

    steer: (command) => rpcClient.steer({ command }),

    respondQuestions: (requestId, answers) =>
      rpcClient.respondQuestions({ requestId, answers: [...answers.map((a) => [...a])] }),

    respondPermission: (requestId, decision) =>
      rpcClient.respondPermission({ requestId, decision }),

    respondPlan: (requestId, decision, reason) =>
      rpcClient.respondPlan({
        requestId,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      }),

    runtime,
  }
}
