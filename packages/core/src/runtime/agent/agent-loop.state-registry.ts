/**
 * Per-(sessionId, branchId) handle to AgentLoop runtime state.
 *
 * The actor handler in `agent-loop.actor.ts` owns the SubscriptionRef
 * that holds `AgentLoopState`. Read-side callers (`getState`,
 * `watchState`, `getQueue`, `drainQueue`) live on the residual
 * `AgentLoopService` Tag and need access to the same SubscriptionRef
 * without going through actor request/reply.
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
  readonly deregister: (
    sessionId: SessionId,
    branchId: BranchId,
    handle: AgentLoopStateHandle,
  ) => Effect.Effect<void>
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

      return {
        register: (sessionId, branchId, handle) =>
          Ref.update(ref, (m) => {
            const next = new Map(m)
            next.set(stateKey(sessionId, branchId), handle)
            return next
          }),
        deregister: (sessionId, branchId, handle) =>
          Ref.update(ref, (m) => {
            const key = stateKey(sessionId, branchId)
            const current = m.get(key)
            if (current === undefined) return m
            // Identity by loopRef — wrapper objects may be reconstructed.
            if (current.loopRef !== handle.loopRef) return m
            const next = new Map(m)
            next.delete(key)
            return next
          }),
        find: (sessionId, branchId) =>
          Ref.get(ref).pipe(Effect.map((m) => m.get(stateKey(sessionId, branchId)))),
      }
    }),
  )
}
