import type { Effect, Schema } from "effect"
import type { AgentName } from "./agent"
import type { BranchId, SessionId, ToolCallId } from "./ids"

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
}

// Tool Factory

export const defineTool = <
  Name extends string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends Schema.Decoder<any, never>,
  Result,
  Error,
  Deps,
>(
  definition: ToolDefinition<Name, Params, Result, Error, Deps>,
): ToolDefinition<Name, Params, Result, Error, Deps> => definition

// Use any for variance - tools have varying params/result/error/deps types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<string, any, any, any, any>
