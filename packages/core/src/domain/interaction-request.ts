/**
 * Shared deferred-based interaction mechanics.
 *
 * Each handler (Permission, Prompt, Handoff, AskUser) uses the same pattern:
 * generate requestId → create Deferred → store in Map → publish event →
 * await Deferred → cleanup. This utility extracts that plumbing while
 * letting typed facades keep their specific semantics.
 *
 * Durability: when a `storage` config is provided, pending requests are
 * persisted to SQLite so they survive server restarts. On recovery,
 * `rehydrate` loads pending records and re-publishes their events so
 * clients re-present dialogs.
 */

import { Clock, Deferred, Effect } from "effect"
import type { EventStoreError } from "./event"
import type { BranchId, SessionId } from "./ids"

// ============================================================================
// Durable interaction record
// ============================================================================

export type InteractionRequestStatus = "pending" | "resolved"

export type InteractionRequestType = "permission" | "prompt" | "handoff" | "ask-user"

export interface InteractionRequestRecord {
  readonly requestId: string
  readonly type: InteractionRequestType
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly paramsJson: string
  readonly status: InteractionRequestStatus
  readonly createdAt: number
}

// ============================================================================
// Interaction service
// ============================================================================

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
  /** Rehydrate a persisted request — creates deferred, adds to pending map, re-publishes event */
  readonly rehydrate: (requestId: string, params: TParams) => Effect.Effect<void, EventStoreError>
}

/**
 * Storage callbacks for durable interaction requests.
 * Errors are caught at the callback site — these must not fail.
 */
export interface InteractionStorageConfig {
  readonly persist: (record: InteractionRequestRecord) => Effect.Effect<void, never>
  readonly resolve: (requestId: string) => Effect.Effect<void, never>
}

export interface InteractionServiceConfig<TParams, TDecision> {
  readonly type: InteractionRequestType
  readonly onPresent: (requestId: string, params: TParams) => Effect.Effect<void, EventStoreError>
  readonly onRespond: (
    requestId: string,
    params: TParams,
    decision: TDecision,
    extra?: string,
  ) => Effect.Effect<void, EventStoreError>
  readonly autoResolve?: (params: TParams) => TDecision | undefined
  /** Extract session/branch from params for durable persistence */
  readonly getContext?: (params: TParams) => { sessionId: SessionId; branchId: BranchId }
  /** Storage callbacks — omit for in-memory-only (tests) */
  readonly storage?: InteractionStorageConfig
}

export const makeInteractionService = <TParams, TDecision>(
  config: InteractionServiceConfig<TParams, TDecision>,
): InteractionService<TParams, TDecision> => {
  const pending = new Map<string, PendingEntry<TParams, TDecision>>()

  return {
    pending,

    present: Effect.fn("InteractionService.present")(function* (params: TParams) {
      const auto = config.autoResolve?.(params)
      if (auto !== undefined) return auto

      const requestId = Bun.randomUUIDv7()
      const deferred = yield* Deferred.make<TDecision>()
      pending.set(requestId, { deferred, params })

      // Persist to storage before publishing event (crash-safe)
      if (config.storage !== undefined && config.getContext !== undefined) {
        const ctx = config.getContext(params)
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const paramsJson = JSON.stringify(params)
        yield* config.storage.persist({
          requestId,
          type: config.type,
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          paramsJson,
          status: "pending",
          createdAt: yield* Clock.currentTimeMillis,
        })
      }

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

      // Publish response event before marking resolved in storage.
      // If we crash after deferred.succeed but before onRespond, the storage
      // record stays pending and recovery can re-present the dialog.
      yield* config.onRespond(requestId, entry.params, decision, extra)

      // Mark resolved in storage (after event publish)
      if (config.storage !== undefined) {
        yield* config.storage.resolve(requestId)
      }

      return entry.params
    }),

    peek: (requestId: string) => pending.get(requestId)?.params,

    rehydrate: Effect.fn("InteractionService.rehydrate")(function* (
      requestId: string,
      params: TParams,
    ) {
      const deferred = yield* Deferred.make<TDecision>()
      pending.set(requestId, { deferred, params })
      yield* config.onPresent(requestId, params)
    }),
  }
}
