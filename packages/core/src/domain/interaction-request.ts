/**
 * Shared deferred-based interaction mechanics.
 *
 * Each handler (Permission, Prompt, Handoff, AskUser) uses the same pattern:
 * generate requestId → create Deferred → store in Map → publish event →
 * await Deferred → cleanup. This utility extracts that plumbing while
 * letting typed facades keep their specific semantics.
 */

import { Deferred, Effect } from "effect"
import type { EventStoreError } from "./event"

export interface PendingEntry<TParams, TDecision> {
  readonly deferred: Deferred.Deferred<TDecision>
  readonly params: TParams
}

export interface InteractionService<TParams, TDecision> {
  readonly present: (params: TParams) => Effect.Effect<TDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: TDecision,
    extra?: string,
  ) => Effect.Effect<TParams | undefined, EventStoreError>
  readonly peek: (requestId: string) => TParams | undefined
  readonly pending: Map<string, PendingEntry<TParams, TDecision>>
}

export const makeInteractionService = <TParams, TDecision>(config: {
  readonly onPresent: (requestId: string, params: TParams) => Effect.Effect<void, EventStoreError>
  readonly onRespond: (
    requestId: string,
    params: TParams,
    decision: TDecision,
    extra?: string,
  ) => Effect.Effect<void, EventStoreError>
  readonly autoResolve?: (params: TParams) => TDecision | undefined
}): InteractionService<TParams, TDecision> => {
  const pending = new Map<string, PendingEntry<TParams, TDecision>>()

  return {
    pending,

    present: Effect.fn("InteractionService.present")(function* (params: TParams) {
      const auto = config.autoResolve?.(params)
      if (auto !== undefined) return auto

      const requestId = Bun.randomUUIDv7()
      const deferred = yield* Deferred.make<TDecision>()
      pending.set(requestId, { deferred, params })

      yield* config.onPresent(requestId, params)

      const decision = yield* Deferred.await(deferred)
      pending.delete(requestId)
      return decision
    }),

    respond: Effect.fn("InteractionService.respond")(function* (
      requestId: string,
      decision: TDecision,
      extra?: string,
    ) {
      const entry = pending.get(requestId)
      if (entry === undefined) return undefined

      pending.delete(requestId)
      // Unblock the caller first — event publish failure must not hang the tool
      yield* Deferred.succeed(entry.deferred, decision)
      yield* config.onRespond(requestId, entry.params, decision, extra)
      return entry.params
    }),

    peek: (requestId: string) => pending.get(requestId)?.params,
  }
}
