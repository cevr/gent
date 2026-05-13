import { Effect, Layer } from "effect"
import { ShardingConfig } from "effect/unstable/cluster"
import { Actor } from "effect-encore"
import type { PromptSection } from "../../domain/prompt.js"
import { buildAgentLoopActorHandlers } from "./agent-loop.handlers.js"
import { AgentLoop } from "./agent-loop.protocol.js"

export { AgentLoop } from "./agent-loop.protocol.js"

export const AgentLoopLiveActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Layer.unwrap(
    Actor.provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toLayer(AgentLoop, build, {
          // Long-lived turn execution is owned by AgentLoopBehavior's worker queue.
          // `concurrency: "unbounded"` keeps short ops (RecordToolResult,
          // RespondInteraction, Steer) from waiting on unrelated mailbox handlers.
          concurrency: "unbounded",
        }),
      ),
    ),
  )

export const AgentLoopTestActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Layer.unwrap(
    Actor.provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toTestLayer(AgentLoop, build, {
          // Match the production mailbox behavior used by AgentLoopLiveActor.
          concurrency: "unbounded",
        }).pipe(Layer.provide(ShardingConfig.layerDefaults)),
      ),
    ),
  )
