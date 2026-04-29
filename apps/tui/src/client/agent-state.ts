import type { AgentName } from "@gent/core/domain/agent.js"
import type { ModelId } from "@gent/core/domain/model.js"

export type AgentStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "streaming" }
  | { readonly _tag: "error"; readonly error: string }

export const AgentStatus = {
  idle: (): AgentStatus => ({ _tag: "idle" }),
  streaming: (): AgentStatus => ({ _tag: "streaming" }),
  error: (error: string): AgentStatus => ({ _tag: "error", error }),
} as const

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
