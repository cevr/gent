import { Schema } from "effect"
import type * as Option from "effect/Option"
import type { AgentName, ModelId, ReasoningEffort } from "@gent/core/protocol"

export const AgentStatus = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Streaming", {}),
  Schema.TaggedStruct("Error", { error: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type AgentStatus = Schema.Schema.Type<typeof AgentStatus>

export interface AgentState {
  agent: Option.Option<AgentName>
  status: AgentStatus
  cost: number
  /**
   * What the next turn would use, resolved by the server from session
   * settings, config, and the agent definition (`SessionSnapshot.resolved*`).
   * Hydrated from the snapshot and refreshed after every settings change.
   */
  resolvedModelId: Option.Option<ModelId>
  resolvedReasoningLevel: Option.Option<ReasoningEffort>
}
