import type { Effect, Schema } from "effect"
import type { AgentName } from "./agent"
import type { EventStoreError } from "./event"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtensionProtocolError,
  ExtractExtensionReply,
} from "./extension-protocol"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import type {
  ApprovalDecision,
  ApprovalRequest,
  InteractionPendingError,
} from "./interaction-request"

// Tool Action — classifies what a tool does for agent filtering

export type ToolAction = "read" | "edit" | "exec" | "delegate" | "interact" | "network" | "state"

// Tool Definition

// Params must have no context requirement (never) for sync decoding
export interface ToolDefinition<
  Name extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends Schema.Decoder<any, never> = Schema.Decoder<any, never>,
  Result = unknown,
  Error = never,
  Deps = never,
> {
  readonly name: Name
  readonly action: ToolAction
  readonly description: string
  readonly concurrency?: "serial" | "parallel"
  /** Whether this tool is safe to replay after restart (read-only tools = true) */
  readonly idempotent?: boolean
  /** One-liner for system prompt tool list (distinct from description which goes to LLM tool schema) */
  readonly promptSnippet?: string
  /** Behavioral guidelines injected into system prompt when this tool is active */
  readonly promptGuidelines?: ReadonlyArray<string>
  /** If true, tool requires an interactive session (human at the terminal).
   *  Filtered out in headless mode and subagent contexts. */
  readonly interactive?: boolean
  readonly params: Params
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: ToolContext,
  ) => Effect.Effect<Result, Error, Deps>
}

export interface ToolContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolCallId: ToolCallId
  readonly agentName?: AgentName
  /** Working directory — replaces direct RuntimePlatform access in tools */
  readonly cwd: string
  /** Home directory — replaces direct RuntimePlatform access in tools */
  readonly home: string
  /** Extension actor RPC — replaces direct ExtensionStateRuntime access in tools */
  readonly extensions: ToolContextExtensions
  /** Request human approval. Cold — throws InteractionPendingError, machine parks, survives restarts.
   *  Wired by ToolRunner.Live — available in all tool execute() calls. */
  readonly approve: (
    params: ApprovalRequest,
  ) => Effect.Effect<ApprovalDecision, EventStoreError | InteractionPendingError>
}

export interface ToolContextExtensions {
  /** Fire-and-forget message to an extension actor */
  readonly send: (
    message: AnyExtensionCommandMessage,
    branchId?: BranchId,
  ) => Effect.Effect<void, ExtensionProtocolError>
  /** Request/reply with an extension actor */
  readonly ask: <M extends AnyExtensionRequestMessage>(
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>
}

// Tool Factory

/** Brand symbol for detecting full ToolDefinition vs SimpleToolDef in overloaded APIs */
export const ToolDefinitionBrand: unique symbol = Symbol.for("@gent/ToolDefinition")

export const defineTool = <
  Name extends string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends Schema.Decoder<any, never>,
  Result,
  Error,
  Deps,
>(
  definition: ToolDefinition<Name, Params, Result, Error, Deps>,
): ToolDefinition<Name, Params, Result, Error, Deps> => {
  Object.defineProperty(definition, ToolDefinitionBrand, {
    value: true,
    enumerable: false,
    writable: false,
  })
  return definition
}

// Use any for variance - tools have varying params/result/error/deps types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<string, any, any, any, any>
