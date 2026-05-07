/**
 * Cross-(workspaceId, sessionId, branchId) session lifecycle governance for AgentLoop.
 *
 * `terminateSession(sessionId)` marks all branches of a session as
 * terminated, blocking new operations from spawning a fresh loop
 * instance. `restoreSession(sessionId)` clears the marker.
 *
 * Encore actor handlers run per (entityType, entityId) where entityId
 * is `(sessionId, branchId)`. This governance lives ABOVE the per-
 * entity scope so the same `terminatedSessionsRef` Set is consulted
 * by every entity instance for the session.
 *
 * @module
 */

import { Context, Effect, Layer, Ref } from "effect"
import type { SessionId } from "../../domain/ids.js"

export interface AgentLoopSessionGovernanceService {
  readonly markTerminated: (workspaceId: string, sessionId: SessionId) => Effect.Effect<void>
  readonly clearTerminated: (workspaceId: string, sessionId: SessionId) => Effect.Effect<void>
  readonly isTerminated: (workspaceId: string, sessionId: SessionId) => Effect.Effect<boolean>
}

export class AgentLoopSessionGovernance extends Context.Service<
  AgentLoopSessionGovernance,
  AgentLoopSessionGovernanceService
>()("@gent/core/src/runtime/agent/agent-loop.session-governance/AgentLoopSessionGovernance") {
  static Live: Layer.Layer<AgentLoopSessionGovernance> = Layer.effect(
    AgentLoopSessionGovernance,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, ReadonlySet<SessionId>>>(new Map())
      return {
        markTerminated: (workspaceId, sessionId) =>
          Ref.update(ref, (m) => {
            const next = new Map(m)
            const sessions = new Set<SessionId>(next.get(workspaceId) ?? new Set<SessionId>())
            sessions.add(sessionId)
            next.set(workspaceId, sessions)
            return next
          }),
        clearTerminated: (workspaceId, sessionId) =>
          Ref.update(ref, (m) => {
            const sessions = m.get(workspaceId)
            if (sessions === undefined || !sessions.has(sessionId)) return m
            const nextSessions = new Set(sessions)
            nextSessions.delete(sessionId)
            const next = new Map(m)
            if (nextSessions.size === 0) {
              next.delete(workspaceId)
            } else {
              next.set(workspaceId, nextSessions)
            }
            return next
          }),
        isTerminated: (workspaceId, sessionId) =>
          Ref.get(ref).pipe(Effect.map((m) => m.get(workspaceId)?.has(sessionId) ?? false)),
      }
    }),
  )
}
