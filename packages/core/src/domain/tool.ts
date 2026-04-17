import type { Effect, Schema } from "effect"
import type { ToolCallId } from "./ids"
import type { ExtensionHostContext } from "./extension-host-context"

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
  readonly description: string
  /**
   * Named resources this tool needs exclusive access to while running. Two
   * tools requesting the same resource name run serially against each other;
   * tools with disjoint resource sets run in parallel. Empty/undefined =
   * fully parallel. Replaces the pre-Phase-6 `concurrency: "serial" | "parallel"`
   * boolean flag (which couldn't distinguish "serial against the global bash
   * lock" from "serial against my own writes").
   */
  readonly resources?: ReadonlyArray<string>
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

export interface ToolContext extends ExtensionHostContext {
  readonly toolCallId: ToolCallId
}

// Tool Factory

/** Brand symbol identifying values produced by `defineTool`. */
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
