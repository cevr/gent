/**
 * Per-(sessionId, branchId) handle to AgentLoop runtime state.
 *
 * The actor handler in `agent-loop.actor.ts` owns the SubscriptionRef
 * that holds `AgentLoopState`. Pure read-side callers (`getState`,
 * `watchState`, `getQueue`) live on the residual `AgentLoopService`
 * Tag and need access to the same SubscriptionRef without going
 * through actor request/reply.
 *
 * `drainQueue` MUTATES queue state and is intentionally NOT served
 * from the registry — in C5.4.4.c it becomes an actor op so the
 * actor remains the single mutator of its own state.
 *
 * This registry is the shared per-(sessionId, branchId) lookup surface.
 * The actor handler registers a handle on entity-instance construction
 * and deregisters on instance scope finalization. Read-side callers
 * look up the registry by `(sessionId, branchId)`; if no entry exists,
 * the session is either cold (synthesize idle state from storage) or
 * never been started.
 *
 * Introduced in C5.4.4.a as architectural scaffolding. C5.4.4.c moves
 * the SubscriptionRef ownership from `makeLoop` (in `agent-loop.ts`)
 * into the actor handler closure; this registry is the bridge.
 *
 * @module
 */

import { Context, Effect, Layer, Ref, type Semaphore, type SubscriptionRef } from "effect"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type { AgentLoopState } from "./agent-loop.state.js"

export type AgentLoopStateHandle = {
  readonly loopRef: SubscriptionRef.SubscriptionRef<AgentLoopState>
  readonly queueMutationSemaphore: Semaphore.Semaphore
}

const stateKey = (sessionId: SessionId, branchId: BranchId): string => `${sessionId}:${branchId}`

export interface AgentLoopStateRegistryService {
  readonly register: (
    sessionId: SessionId,
    branchId: BranchId,
    handle: AgentLoopStateHandle,
  ) => Effect.Effect<void>
  /**
   * Removes the registry entry for `(sessionId, branchId)` if and only if
   * the currently-registered handle's `loopRef` matches `loopRef`.
   *
   * The `loopRef` itself is the registration token — wrapper structs are
   * reconstructed at call sites, so identity-by-`loopRef` correctly
   * protects against deleting a newer registration after a re-create.
   */
  readonly deregister: (
    sessionId: SessionId,
    branchId: BranchId,
    loopRef: SubscriptionRef.SubscriptionRef<AgentLoopState>,
  ) => Effect.Effect<void>
  /**
   * Removes ALL registry entries matching `sessionId` (any branch).
   * Used by `terminateSession` to keep registry cleanup in the same
   * critical section as the legacy loopsRef cleanup, so no stale handle
   * is observable to read-side callers between deletion and finalization.
   */
  readonly deregisterSession: (sessionId: SessionId) => Effect.Effect<void>
  readonly find: (
    sessionId: SessionId,
    branchId: BranchId,
  ) => Effect.Effect<AgentLoopStateHandle | undefined>
}

export class AgentLoopStateRegistry extends Context.Service<
  AgentLoopStateRegistry,
  AgentLoopStateRegistryService
>()("@gent/core/src/runtime/agent/agent-loop.state-registry/AgentLoopStateRegistry") {
  static Live: Layer.Layer<AgentLoopStateRegistry> = Layer.effect(
    AgentLoopStateRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Map<string, AgentLoopStateHandle>>(new Map())

      const sessionPrefix = (sessionId: SessionId): string => `${sessionId}:`
      return {
        register: (sessionId, branchId, handle) =>
          Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(stateKey(sessionId, branchId), handle)
            return next
          }),
        deregister: (sessionId, branchId, loopRef) =>
          Ref.update(ref, (m) => {
            const key = stateKey(sessionId, branchId)
            const current = m.get(key)
            if (current === undefined) return m
            if (current.loopRef !== loopRef) return m
            const next = new Map(m)
            next.delete(key)
            return next
          }),
        deregisterSession: (sessionId) =>
          Ref.update(ref, (m) => {
            const prefix = sessionPrefix(sessionId)
            let touched = false
            const next = new Map(m)
            for (const key of m.keys()) {
              if (key.startsWith(prefix)) {
                next.delete(key)
                touched = true
              }
            }
            return touched ? next : m
          }),
        find: (sessionId, branchId) =>
          Ref.get(ref).pipe(Effect.map((m) => m.get(stateKey(sessionId, branchId)))),
      }
    }),
  )
}
