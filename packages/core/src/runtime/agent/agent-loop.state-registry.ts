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

/**
 * Nested map: SessionId → BranchId → handle. Counsel finding from C5.4.4.a:
 * delimiter-encoded `${sessionId}:${branchId}` is structurally unsound since
 * SessionId/BranchId are unconstrained branded strings — a `:` in either
 * collides. Nested maps make collision impossible.
 */
type Registry = ReadonlyMap<SessionId, ReadonlyMap<BranchId, AgentLoopStateHandle>>

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
  /**
   * Lists the branchIds currently registered under `sessionId`. Used by
   * `terminateSession` to drive a cross-entity actor sweep without resurrecting
   * the legacy `loopsRef` map.
   */
  readonly listForSession: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<BranchId>>
}

export class AgentLoopStateRegistry extends Context.Service<
  AgentLoopStateRegistry,
  AgentLoopStateRegistryService
>()("@gent/core/src/runtime/agent/agent-loop.state-registry/AgentLoopStateRegistry") {
  static Live: Layer.Layer<AgentLoopStateRegistry> = Layer.effect(
    AgentLoopStateRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Registry>(new Map())

      return {
        register: (sessionId, branchId, handle) =>
          Ref.update(ref, (m) => {
            const next = new Map(m)
            const branches = new Map(next.get(sessionId) ?? new Map())
            branches.set(branchId, handle)
            next.set(sessionId, branches)
            return next
          }),
        deregister: (sessionId, branchId, loopRef) =>
          Ref.update(ref, (m) => {
            const branches = m.get(sessionId)
            if (branches === undefined) return m
            const current = branches.get(branchId)
            if (current === undefined) return m
            if (current.loopRef !== loopRef) return m
            const nextBranches = new Map(branches)
            nextBranches.delete(branchId)
            const next = new Map(m)
            if (nextBranches.size === 0) {
              next.delete(sessionId)
            } else {
              next.set(sessionId, nextBranches)
            }
            return next
          }),
        deregisterSession: (sessionId) =>
          Ref.update(ref, (m) => {
            if (!m.has(sessionId)) return m
            const next = new Map(m)
            next.delete(sessionId)
            return next
          }),
        find: (sessionId, branchId) =>
          Ref.get(ref).pipe(Effect.map((m) => m.get(sessionId)?.get(branchId))),
        listForSession: (sessionId) =>
          Ref.get(ref).pipe(
            Effect.map((m) => {
              const branches = m.get(sessionId)
              return branches === undefined ? [] : Array.from(branches.keys())
            }),
          ),
      }
    }),
  )
}
