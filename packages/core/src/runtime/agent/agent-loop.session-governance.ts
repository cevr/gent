/**
 * Cross-(sessionId, branchId) session lifecycle governance for AgentLoop.
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
 * Introduced in C5.4.4.a as architectural scaffolding (current
 * `agent-loop.ts` still owns the actual Set). C5.4.4.b moves the Set
 * here and deletes the in-`agent-loop.ts` reference.
 *
 * @module
 */

import { Context, Effect, Layer, Ref } from "effect"
import type { SessionId } from "../../domain/ids.js"

export interface AgentLoopSessionGovernanceService {
  readonly markTerminated: (sessionId: SessionId) => Effect.Effect<void>
  readonly clearTerminated: (sessionId: SessionId) => Effect.Effect<void>
  readonly isTerminated: (sessionId: SessionId) => Effect.Effect<boolean>
}

export class AgentLoopSessionGovernance extends Context.Service<
  AgentLoopSessionGovernance,
  AgentLoopSessionGovernanceService
>()("@gent/core/src/runtime/agent/agent-loop.session-governance/AgentLoopSessionGovernance") {
  static Live: Layer.Layer<AgentLoopSessionGovernance> = Layer.effect(
    AgentLoopSessionGovernance,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Set<SessionId>>(new Set())
      return {
        markTerminated: (sessionId) =>
          Ref.update(ref, (s) => {
            const next = new Set(s)
            next.add(sessionId)
            return next
          }),
        clearTerminated: (sessionId) =>
          Ref.update(ref, (s) => {
            if (!s.has(sessionId)) return s
            const next = new Set(s)
            next.delete(sessionId)
            return next
          }),
        isTerminated: (sessionId) => Ref.get(ref).pipe(Effect.map((s) => s.has(sessionId))),
      }
    }),
  )
}
