import { Effect, Layer } from "effect"
import { ShardingConfig } from "effect/unstable/cluster"
import { Actor, ActorStateRegistry } from "effect-encore"
import type { PromptSection } from "../../domain/prompt.js"
import { buildAgentLoopActorHandlers } from "./agent-loop.handlers.js"
import { provideLayerBuildContext } from "./agent-loop.runtime-context.js"
import { AgentLoop } from "./agent-loop.protocol.js"

export { AgentLoop } from "./agent-loop.protocol.js"

export const AgentLoopLiveActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Layer.unwrap(
    provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toLayer(AgentLoop, build, {
          // Long-lived turn execution is owned by AgentLoopBehavior's worker queue.
          // `concurrency: "unbounded"` keeps short ops (RecordToolResult,
          // RespondInteraction, Steer) from waiting on unrelated mailbox handlers.
          concurrency: "unbounded",
        }).pipe(Layer.provideMerge(ActorStateRegistry.Live)),
      ),
    ),
  )

export const AgentLoopTestActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Layer.unwrap(
    provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toTestLayer(AgentLoop, build, {
          // Match the production mailbox behavior used by AgentLoopLiveActor.
          concurrency: "unbounded",
        }).pipe(
          Layer.provideMerge(ActorStateRegistry.Live),
          Layer.provide(ShardingConfig.layerDefaults),
        ),
      ),
    ),
  )
