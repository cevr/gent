import { Context, Effect, Layer, Schema } from "effect"

// Tool Definition

// Params must have no context requirement (never) for sync decoding
export interface ToolDefinition<
  Name extends string = string,
  Params extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
  Result = unknown,
  Error = never,
  Deps = never,
> {
  readonly name: Name
  readonly description: string
  readonly params: Params
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: ToolContext,
  ) => Effect.Effect<Result, Error, Deps>
}

export interface ToolContext {
  readonly sessionId: string
  readonly branchId: string
  readonly toolCallId: string
}

// Tool Factory

export const defineTool = <
  Name extends string,
  Params extends Schema.Schema.AnyNoContext,
  Result,
  Error,
  Deps,
>(
  definition: ToolDefinition<Name, Params, Result, Error, Deps>,
): ToolDefinition<Name, Params, Result, Error, Deps> => definition

// Tool Registry Service

// Use any for variance - tools have varying params/result/error/deps types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<string, any, any, any, any>

export interface ToolRegistryService {
  readonly get: (name: string) => Effect.Effect<AnyToolDefinition | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<AnyToolDefinition>>
  readonly register: (tool: AnyToolDefinition) => Effect.Effect<void>
}

export class ToolRegistry extends Context.Tag("ToolRegistry")<ToolRegistry, ToolRegistryService>() {
  static Live = (tools: ReadonlyArray<AnyToolDefinition>): Layer.Layer<ToolRegistry> =>
    Layer.succeed(ToolRegistry, {
      get: (name) => Effect.succeed(tools.find((t) => t.name === name)),
      list: () => Effect.succeed(tools),
      register: () => Effect.void,
    })

  static Test = (): Layer.Layer<ToolRegistry> =>
    Layer.succeed(ToolRegistry, {
      get: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      register: () => Effect.void,
    })
}

// Tool Execution Result

export class ToolSuccess extends Schema.TaggedClass<ToolSuccess>()("ToolSuccess", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.Unknown,
}) {}

export class ToolError extends Schema.TaggedClass<ToolError>()("ToolError", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  error: Schema.String,
}) {}

export const ToolExecutionResult = Schema.Union(ToolSuccess, ToolError)
export type ToolExecutionResult = typeof ToolExecutionResult.Type
