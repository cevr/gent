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

import { Context, Effect, HashMap, HashSet, Layer, TxRef } from "effect"
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
      const ref = yield* TxRef.make(HashMap.empty<string, HashSet.HashSet<SessionId>>())
      return {
        markTerminated: (workspaceId, sessionId) =>
          TxRef.update(ref, (m) => {
            const sessions = HashMap.get(m, workspaceId).pipe((opt) =>
              opt._tag === "Some" ? opt.value : HashSet.empty<SessionId>(),
            )
            return HashMap.set(m, workspaceId, HashSet.add(sessions, sessionId))
          }),
        clearTerminated: (workspaceId, sessionId) =>
          TxRef.update(ref, (m) => {
            const opt = HashMap.get(m, workspaceId)
            if (opt._tag === "None" || !HashSet.has(opt.value, sessionId)) return m
            const nextSessions = HashSet.remove(opt.value, sessionId)
            return HashSet.size(nextSessions) === 0
              ? HashMap.remove(m, workspaceId)
              : HashMap.set(m, workspaceId, nextSessions)
          }),
        isTerminated: (workspaceId, sessionId) =>
          TxRef.get(ref).pipe(
            Effect.map((m) => {
              const opt = HashMap.get(m, workspaceId)
              return opt._tag === "Some" && HashSet.has(opt.value, sessionId)
            }),
          ),
      }
    }),
  )
}
