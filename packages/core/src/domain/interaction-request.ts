/**
 * Cold interaction mechanics.
 *
 * Each handler (Prompt, Handoff, AskUser) uses the same pattern:
 * generate requestId → persist to storage → publish event → fail with
 * InteractionPendingError. The agent loop machine catches this and
 * transitions to WaitingForInteraction. When the client responds,
 * the resolution is stored and the machine resumes ExecutingTools —
 * the tool re-calls present(), finds the stored resolution, and continues.
 *
 * No Deferred, no blocked fiber. Interactions survive server restarts.
 */

import { Clock, Effect, Schema } from "effect"
import { EventStoreError } from "./event"
import type { BranchId, SessionId } from "./ids"

// ============================================================================
// Interaction pending signal
// ============================================================================

export class InteractionPendingError {
  readonly _tag = "InteractionPendingError" as const
  constructor(
    readonly requestId: string,
    readonly interactionType: InteractionRequestType,
    readonly sessionId: SessionId,
    readonly branchId: BranchId,
  ) {}
}

// ============================================================================
// Durable interaction record
// ============================================================================

export type InteractionRequestStatus = "pending" | "resolved"

export type InteractionRequestType = "prompt" | "handoff" | "ask-user"

export interface InteractionRequestRecord {
  readonly requestId: string
  readonly type: InteractionRequestType
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly paramsJson: string
  readonly status: InteractionRequestStatus
  readonly createdAt: number
}

const interactionJsonCodec = <TParams>(schema: Schema.Schema<TParams>) =>
  Schema.fromJsonString(schema as Schema.Any)

export const encodeInteractionParams = <TParams>(
  schema: Schema.Schema<TParams>,
  params: TParams,
  interactionType: InteractionRequestType,
): Effect.Effect<string, EventStoreError> =>
  Schema.encodeEffect(interactionJsonCodec(schema))(params).pipe(
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: `Failed to encode ${interactionType} interaction params`,
          cause,
        }),
    ),
  )

export const decodeInteractionParams = <TParams>(
  schema: Schema.Schema<TParams>,
  paramsJson: string,
  interactionType: InteractionRequestType,
): Effect.Effect<TParams, EventStoreError> =>
  Schema.decodeUnknownEffect(interactionJsonCodec(schema))(paramsJson).pipe(
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: `Failed to decode ${interactionType} interaction params`,
          cause,
        }),
    ),
  )

// ============================================================================
// Interaction service
// ============================================================================

export interface InteractionService<TParams, TDecision> {
  readonly present: (
    params: TParams,
  ) => Effect.Effect<TDecision, EventStoreError | InteractionPendingError>
  readonly respond: (
    requestId: string,
    decision: TDecision,
    extra?: string,
  ) => Effect.Effect<void, EventStoreError>
  /** Store a resolution for cold-mode resumption (keyed by session+branch) */
  readonly storeResolution: (sessionId: SessionId, branchId: BranchId, decision: TDecision) => void
  /** Re-publish event for a persisted pending request (recovery after restart) */
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
  readonly paramsSchema?: Schema.Schema<TParams>
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
  /** Stored resolutions for cold interaction resumption — keyed by "sessionId:branchId" */
  const storedResolutions = new Map<string, TDecision>()
  const resolutionKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

  return {
    storeResolution: (sessionId, branchId, decision) => {
      storedResolutions.set(resolutionKey(sessionId, branchId), decision)
    },

    present: Effect.fn("InteractionService.present")(function* (params: TParams) {
      const auto = config.autoResolve?.(params)
      if (auto !== undefined) return auto

      // Check for a stored resolution (cold interaction resumption).
      // When the machine re-enters ExecutingTools after WaitingForInteraction,
      // the tool re-calls present(). The resolution was stored by respond()
      // keyed by session+branch.
      const ctx = config.getContext?.(params)
      if (ctx !== undefined) {
        const key = resolutionKey(ctx.sessionId, ctx.branchId)
        const stored = storedResolutions.get(key)
        if (stored !== undefined) {
          storedResolutions.delete(key)
          // Resolve in storage so it's not rehydrated on next restart
          if (config.storage !== undefined) {
            // Use a no-op requestId since we don't know the original
            // (storage.resolve is a best-effort cleanup)
          }
          return stored
        }
      }

      const requestId = Bun.randomUUIDv7()

      // Persist to storage before publishing event (crash-safe)
      if (config.storage !== undefined && config.getContext !== undefined) {
        if (config.paramsSchema === undefined) {
          return yield* Effect.fail(
            new EventStoreError({
              message: `${config.type} interaction storage requires paramsSchema`,
            }),
          )
        }
        const storageCtx = config.getContext(params)
        const paramsJson = yield* encodeInteractionParams(config.paramsSchema, params, config.type)
        yield* config.storage.persist({
          requestId,
          type: config.type,
          sessionId: storageCtx.sessionId,
          branchId: storageCtx.branchId,
          paramsJson,
          status: "pending",
          createdAt: yield* Clock.currentTimeMillis,
        })
      }

      yield* config.onPresent(requestId, params)

      // Signal the machine to park in WaitingForInteraction.
      // The tool fiber exits, the machine checkpoints, and when respond() is called,
      // it stores the resolution. The machine resumes ExecutingTools, the tool re-runs,
      // and present() finds the stored resolution above.
      const pendingCtx = ctx ?? config.getContext?.(params)
      return yield* Effect.fail(
        new InteractionPendingError(
          requestId,
          config.type,
          pendingCtx?.sessionId ?? ("" as SessionId),
          pendingCtx?.branchId ?? ("" as BranchId),
        ),
      )
    }),

    respond: Effect.fn("InteractionService.respond")(function* (
      requestId: string,
      _decision: TDecision,
      _extra?: string,
    ) {
      // Resolve in storage
      if (config.storage !== undefined) {
        yield* config.storage.resolve(requestId)
      }
    }),

    rehydrate: Effect.fn("InteractionService.rehydrate")(function* (
      requestId: string,
      params: TParams,
    ) {
      // Re-publish the event so reconnecting clients render the dialog.
      // No Deferred needed — the machine is in WaitingForInteraction from checkpoint.
      yield* config.onPresent(requestId, params)
    }),
  }
}
