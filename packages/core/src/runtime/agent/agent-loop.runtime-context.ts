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
