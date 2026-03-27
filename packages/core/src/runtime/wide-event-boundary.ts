/**
 * Wide event boundary integration — thin wrapper over effect-wide-event
 * with gent-specific context factories.
 *
 * One structured event per boundary: turn, tool, provider stream, RPC, subagent.
 */

export { WideEvent, withWideEvent, WideEventLogger } from "effect-wide-event"
export type { WideEventContext, WideEventEnvelope } from "effect-wide-event"

import type { WideEventContext } from "effect-wide-event"

export const turnBoundary = (
  sessionId: string,
  branchId: string,
  agent: string,
): WideEventContext => ({
  service: "agent-loop",
  method: "turn",
  actor: agent,
  envelope: { sessionId, branchId },
})

export const toolBoundary = (toolName: string, toolCallId: string): WideEventContext => ({
  service: "tool-runner",
  method: toolName,
  envelope: { toolCallId },
})

export const providerStreamBoundary = (model: string): WideEventContext => ({
  service: "provider",
  method: "stream",
  envelope: { model },
})

export const rpcBoundary = (rpcName: string): WideEventContext => ({
  service: "rpc",
  method: rpcName,
})

export const subagentBoundary = (agentName: string, parentSessionId: string): WideEventContext => ({
  service: "subagent",
  method: "run",
  actor: agentName,
  envelope: { parentSessionId },
})
