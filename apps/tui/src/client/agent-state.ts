import { Schema } from "effect"
import type { AgentName } from "@gent/core/domain/agent.js"
import type { ModelId } from "@gent/core/domain/model.js"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

export const AgentStatus = TaggedEnumClass("AgentStatus", {
  Idle: TaggedEnumClass.variant("idle", {}),
  Streaming: TaggedEnumClass.variant("streaming", {}),
  Error: TaggedEnumClass.variant("error", { error: Schema.String }),
})

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
