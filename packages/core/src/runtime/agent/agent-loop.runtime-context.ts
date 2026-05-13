import type { Context } from "effect"
import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { EventPublisher } from "../../domain/event-publisher.js"
import type { MessageStorage } from "../../storage/message-storage.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import type { EventStorage } from "../../storage/event-storage.js"
import type { ModelResolver } from "../../providers/model-resolver.js"
import type { ModelRegistry } from "../model-registry.js"
import type { ToolRunner } from "./tool-runner.js"
import type { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import type { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import type { GentPlatform } from "../gent-platform.js"

export type AgentLoopRuntimeServices =
  | SessionStorage
  | MessageStorage
  | EventStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ModelRegistry
  | ToolRunner
  | EventPublisher

export type AgentLoopRuntimeContext = Context.Context<AgentLoopRuntimeServices>

export const captureAgentLoopRuntimeContext: Effect.Effect<
  AgentLoopRuntimeContext,
  never,
  AgentLoopRuntimeServices
> = Effect.context<AgentLoopRuntimeServices>()

export const provideAgentLoopRuntimeContext =
  (ctx: AgentLoopRuntimeContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, AgentLoopRuntimeServices>> =>
    Effect.provideContext(effect, ctx)

type AgentLoopBuildContext =
  | AgentLoopRuntimeServices
  | AgentLoopQueueStorage
  | AgentLoopSessionGovernance
  | GentPlatform

/**
 * Snapshots the actor layer-build context and provides it into the per-entity
 * build effect.
 *
 * Why: `Actor.toLayer(actor, build, opts)` does not propagate `build`'s
 * R-channel to the resulting layer. Sharding captures its service context at
 * entity registration time and provides it into `build` per entity. In an
 * ephemeral runtime composed with `Layer.provideMerge(child, parent)`, that
 * captured context may resolve services from the parent layer, bypassing child
 * overrides such as ephemeral SQLite. This adapter is the one named exception:
 * it captures only the actor-runtime slice that must follow the child layer.
 */
export const provideLayerBuildContext = <A, E, R>(
  build: Effect.Effect<A, E, R>,
): Effect.Effect<
  Effect.Effect<A, E, Exclude<R, AgentLoopBuildContext>>,
  never,
  AgentLoopBuildContext
> =>
  Effect.context<AgentLoopBuildContext>().pipe(
    Effect.map(
      (ctx) =>
        Effect.provideContext(build, ctx) as Effect.Effect<A, E, Exclude<R, AgentLoopBuildContext>>,
    ),
  )
