/**
 * Wide event boundary integration — thin wrapper over effect-wide-event
 * with gent-specific turn context factories.
 *
 * One structured event per boundary: turn, tool, provider stream, RPC, agent run.
 *
 * Envelope fields (sessionId, branchId, etc.) are pre-loaded into the boundary's
 * accumulator. Internal code using WideEvent.set() should not overwrite these keys.
 * The library's transport fields (service, status, durationMs, traceId) are always
 * re-applied on final merge and cannot be overwritten.
 */

export { WideEvent, WideEventBoundary, withWideEvent, WideEventLogger } from "effect-wide-event"
export type { WideEventContext, WideEventEnvelope, LogEvent } from "effect-wide-event"

import type { WideEventContext } from "effect-wide-event"
import type { SessionId, BranchId } from "../domain/ids.js"
import type { AgentName } from "../domain/agent.js"

// =============================================================================
// Boundary context factories
// =============================================================================

export const turnBoundary = (
  sessionId: SessionId,
  branchId: BranchId,
  agent: AgentName,
): WideEventContext => ({
  service: "agent-loop",
  method: "turn",
  actor: agent,
  envelope: { sessionId, branchId },
})

export const agentRunBoundary = (
  agentName: AgentName,
  parentSessionId: SessionId,
): WideEventContext => ({
  service: "agent-run",
  method: "run",
  actor: agentName,
  envelope: { parentSessionId },
})
