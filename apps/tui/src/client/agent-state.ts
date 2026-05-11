import { Schema } from "effect"
import type { AgentName } from "@gent/core-internal/domain/agent.js"
import type { ModelId } from "@gent/core-internal/domain/model.js"

export const AgentStatus = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("streaming", {}),
  Schema.TaggedStruct("error", { error: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type AgentStatus = Schema.Schema.Type<typeof AgentStatus>

export interface AgentState {
  agent: AgentName | undefined
  status: AgentStatus
  cost: number
  /**
   * Server-authoritative model id from `SessionSnapshot.metrics.lastModelId`.
   * Mirrors the cost field's flow: hydrated from snapshot, refreshed on
   * `StreamEnded`. Falls back to the agent's default model only when no
   * stream has ended yet for the active session.
   */
  lastModelId: ModelId | undefined
}
