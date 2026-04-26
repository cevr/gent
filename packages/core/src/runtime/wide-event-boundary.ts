/**
 * Wide event boundary integration — thin wrapper over effect-wide-event
 * with gent-specific context factories.
 *
 * One structured event per boundary: turn, tool, provider stream, RPC, agent run.
 *
 * Envelope fields (sessionId, branchId, etc.) are pre-loaded into the boundary's
 * accumulator. Internal code using WideEvent.set() should not overwrite these keys.
 * The library's transport fields (service, status, durationMs, traceId) are always
 * re-applied on final merge and cannot be overwritten.
 */

export { WideEvent, withWideEvent, WideEventLogger } from "effect-wide-event"
export type { WideEventContext, WideEventEnvelope, LogEvent } from "effect-wide-event"

import type { WideEventContext } from "effect-wide-event"
import type { SessionId, BranchId, ToolCallId } from "../domain/ids.js"
import type { AgentName } from "../domain/agent.js"

// =============================================================================
// Tool outcome — canonical values for WideEvent.set({ toolError })
// =============================================================================

/**
 * Canonical tool error codes for wide event annotations.
 *
 * These are set via `WideEvent.set({ toolError: ToolError.PermissionDenied })`
 * inside the tool-runner's `withWideEvent` boundary. The wide event envelope
 * `status` remains "ok" (the effect succeeded), but the tool-level outcome
 * is captured in `toolError`.
 */
export const ToolError = {
  /** Tool name not found in extension registry */
  Unknown: "unknown",
  /** Permission check interceptor threw/defected */
  PermissionCheckFailed: "permission_check_failed",
  /** Permission denied (by policy or user) */
  PermissionDenied: "permission_denied",
  /** Input failed schema decode */
  SchemaDecode: "schema_decode",
  /** Tool execute effect failed */
  ExecutionFailed: "execution_failed",
} as const
export type ToolError = (typeof ToolError)[keyof typeof ToolError]

/**
 * Non-fatal tool warnings. Tool succeeded but a post-processing step failed.
 */
export const ToolWarning = {
  /** tool.result interceptor failed (fallback to raw result) */
  ResultEnrichmentFailed: "result_enrichment_failed",
} as const
export type ToolWarning = (typeof ToolWarning)[keyof typeof ToolWarning]

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

export const toolBoundary = (toolName: string, toolCallId: ToolCallId): WideEventContext => ({
  service: "tool-runner",
  method: toolName,
  envelope: { toolCallId },
})

export const providerStreamBoundary = (model: string): WideEventContext => ({
  service: "provider",
  method: "stream",
  envelope: { model },
})

export const rpcBoundary = (rpcName: string, requestId?: string): WideEventContext => ({
  service: "rpc",
  method: rpcName,
  ...(requestId !== undefined ? { requestId } : {}),
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
