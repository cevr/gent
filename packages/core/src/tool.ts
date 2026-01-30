import { Context, Effect, Layer, type Schema } from "effect"
import type { AgentName } from "./agent/agent-definition"

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
  readonly concurrency?: "serial" | "parallel"
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
  readonly agentName?: AgentName
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

export class ToolRegistry extends Context.Tag("@gent/core/src/tool/ToolRegistry")<
  ToolRegistry,
  ToolRegistryService
>() {
  static Live = (tools: ReadonlyArray<AnyToolDefinition>): Layer.Layer<ToolRegistry> =>
    Layer.succeed(
      ToolRegistry,
      (() => {
        const toolMap = new Map(tools.map((tool) => [tool.name, tool]))
        return {
          get: (name) => Effect.succeed(toolMap.get(name)),
          list: () => Effect.succeed([...toolMap.values()]),
          register: (tool) =>
            Effect.sync(() => {
              toolMap.set(tool.name, tool)
            }),
        }
      })(),
    )

  static Test = (): Layer.Layer<ToolRegistry> =>
    Layer.succeed(ToolRegistry, {
      get: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      register: () => Effect.void,
    })
}
