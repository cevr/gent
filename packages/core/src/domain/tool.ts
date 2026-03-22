import { ServiceMap, Effect, Layer, type Schema } from "effect"
import type { AgentName } from "./agent"
import type { BranchId, SessionId } from "./ids"

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
  readonly concurrency?: "serial" | "parallel"
  /** Whether this tool is safe to replay after restart (read-only tools = true) */
  readonly idempotent?: boolean
  readonly params: Params
  readonly execute: (
    params: Schema.Schema.Type<Params>,
    ctx: ToolContext,
  ) => Effect.Effect<Result, Error, Deps>
}

export interface ToolContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly toolCallId: string
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

// Tool Registry Service

// Use any for variance - tools have varying params/result/error/deps types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<string, any, any, any, any>

export interface ToolRegistryService {
  readonly get: (name: string) => Effect.Effect<AnyToolDefinition | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<AnyToolDefinition>>
  readonly register: (tool: AnyToolDefinition) => Effect.Effect<void>
}

export class ToolRegistry extends ServiceMap.Service<ToolRegistry, ToolRegistryService>()(
  "@gent/core/src/tool/ToolRegistry",
) {
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
