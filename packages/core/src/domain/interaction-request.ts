/**
 * Cold interaction mechanics.
 *
 * Tools call `ctx.interaction.approve({ text, metadata? })` to request human input.
 * The approval service generates a requestId, persists to storage,
 * publishes InteractionPresented, then fails with InteractionPendingError.
 * The agent loop machine catches this and parks in WaitingForInteraction.
 *
 * When the client responds, the resolution `{ approved, notes? }` is stored
 * keyed by requestId. The machine resumes ExecutingTools — the tool re-calls
 * approve(), finds the stored resolution, and continues.
 *
 * No Deferred, no blocked fiber. Interactions survive server restarts.
 */

import { Clock, Effect, Schema } from "effect"
import { EventStoreError } from "./event"
import { BranchId, InteractionRequestId, SessionId } from "./ids"

// ============================================================================
// Approval schemas
// ============================================================================

/** Request params for ctx.interaction.approve() */
export const ApprovalRequestSchema = Schema.Struct({
  text: Schema.String,
  metadata: Schema.optional(Schema.Unknown),
})
export type ApprovalRequest = Schema.Schema.Type<typeof ApprovalRequestSchema>

/** Decision returned from ctx.interaction.approve() */
export const ApprovalDecisionSchema = Schema.Struct({
  approved: Schema.Boolean,
  notes: Schema.optional(Schema.String),
})
export type ApprovalDecision = Schema.Schema.Type<typeof ApprovalDecisionSchema>

// ============================================================================
// Interaction pending signal
// ============================================================================

export class InteractionPendingError extends Schema.TaggedErrorClass<InteractionPendingError>(
  "@gent/core/domain/interaction-request/InteractionPendingError",
)("InteractionPendingError", {
  requestId: InteractionRequestId,
  sessionId: SessionId,
  branchId: BranchId,
}) {}

export class InteractionRequestMismatchError extends Schema.TaggedErrorClass<InteractionRequestMismatchError>(
  "@gent/core/domain/interaction-request/InteractionRequestMismatchError",
)("InteractionRequestMismatchError", {
  message: Schema.String,
  expectedRequestId: Schema.optional(InteractionRequestId),
  actualRequestId: InteractionRequestId,
  sessionId: SessionId,
  branchId: BranchId,
}) {}

// ============================================================================
// Durable interaction record
// ============================================================================

export type InteractionRequestStatus = "pending" | "resolved"

export interface InteractionRequestRecord {
  readonly requestId: InteractionRequestId
  readonly type: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly paramsJson: string
  readonly status: InteractionRequestStatus
  readonly createdAt: number
}

/** All interaction records use this type — the old per-handler types are gone */
export const INTERACTION_TYPE = "approval" as const

const interactionJsonCodec = Schema.fromJsonString(ApprovalRequestSchema)

export const encodeInteractionParams = (
  params: ApprovalRequest,
): Effect.Effect<string, EventStoreError> =>
  Schema.encodeEffect(interactionJsonCodec)(params).pipe(
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: "Failed to encode interaction params",
          cause,
        }),
    ),
  )

export const decodeInteractionParams = (
  paramsJson: string,
): Effect.Effect<ApprovalRequest, EventStoreError> =>
  Schema.decodeUnknownEffect(interactionJsonCodec)(paramsJson).pipe(
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: "Failed to decode interaction params",
          cause,
        }),
    ),
  )

// ============================================================================
// Interaction service
// ============================================================================

export interface InteractionService {
  readonly present: (
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
  ) => Effect.Effect<ApprovalDecision, EventStoreError | InteractionPendingError>
  readonly pendingRequestId: (ctx: {
    sessionId: SessionId
    branchId: BranchId
  }) => InteractionRequestId | undefined
  readonly respond: (requestId: InteractionRequestId) => Effect.Effect<void, EventStoreError>
  /** Store a resolution for cold-mode resumption (keyed by requestId) */
  readonly storeResolution: (requestId: InteractionRequestId, decision: ApprovalDecision) => void
  /** Re-publish event for a persisted pending request (recovery after restart) */
  readonly rehydrate: (
    requestId: InteractionRequestId,
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
  ) => Effect.Effect<void, EventStoreError>
}

/**
 * Storage callbacks for durable interaction requests.
 * Errors are caught at the callback site — these must not fail.
 */
export interface InteractionStorageConfig {
  readonly persist: (record: InteractionRequestRecord) => Effect.Effect<void, never>
  readonly resolve: (requestId: InteractionRequestId) => Effect.Effect<void, never>
}

export interface InteractionServiceConfig {
  readonly onPresent: (
    requestId: InteractionRequestId,
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
  ) => Effect.Effect<void, EventStoreError>
  readonly onRespond?: (
    requestId: InteractionRequestId,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, EventStoreError>
  readonly autoResolve?: (params: ApprovalRequest) => ApprovalDecision | undefined
  /** Storage callbacks — omit for in-memory-only (tests) */
  readonly storage?: InteractionStorageConfig
}

export const makeInteractionService = (config: InteractionServiceConfig): InteractionService => {
  /** Stored resolutions keyed by requestId */
  const storedResolutions = new Map<InteractionRequestId, ApprovalDecision>()
  /** Reverse lookup: sessionId:branchId → requestId (at most one pending per session+branch) */
  const pendingByContext = new Map<string, InteractionRequestId>()
  const contextKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

  return {
    storeResolution: (requestId, decision) => {
      storedResolutions.set(requestId, decision)
    },

    present: Effect.fn("InteractionService.present")(function* (
      params: ApprovalRequest,
      ctx: { sessionId: SessionId; branchId: BranchId },
    ) {
      const auto = config.autoResolve?.(params)
      if (auto !== undefined) return auto

      // Check for a stored resolution (cold interaction resumption).
      // The tool re-calls present() after the machine resumes. The resolution
      // was stored by requestId via storeResolution(). We find the requestId
      // through the context reverse lookup.
      const ctxKey = contextKey(ctx.sessionId, ctx.branchId)
      const pendingRequestId = pendingByContext.get(ctxKey)
      if (pendingRequestId !== undefined) {
        const stored = storedResolutions.get(pendingRequestId)
        if (stored !== undefined) {
          storedResolutions.delete(pendingRequestId)
          pendingByContext.delete(ctxKey)
          if (config.storage !== undefined) {
            yield* config.storage.resolve(pendingRequestId)
          }
          return stored
        }
      }

      const requestId = InteractionRequestId.make(Bun.randomUUIDv7())
      pendingByContext.set(ctxKey, requestId)

      // Persist to storage before publishing event (crash-safe)
      if (config.storage !== undefined) {
        const paramsJson = yield* encodeInteractionParams(params)
        yield* config.storage.persist({
          requestId,
          type: INTERACTION_TYPE,
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          paramsJson,
          status: "pending",
          createdAt: yield* Clock.currentTimeMillis,
        })
      }

      yield* config.onPresent(requestId, params, ctx)

      // Signal the machine to park in WaitingForInteraction.
      return yield* new InteractionPendingError({
        requestId,
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
      })
    }),

    pendingRequestId: (ctx) => pendingByContext.get(contextKey(ctx.sessionId, ctx.branchId)),

    respond: Effect.fn("InteractionService.respond")(function* (requestId: InteractionRequestId) {
      if (config.storage !== undefined) {
        yield* config.storage.resolve(requestId)
      }
      // onRespond is optional — events can be published here if needed
      // but the primary response path is storeResolution + machine wake
    }),

    rehydrate: Effect.fn("InteractionService.rehydrate")(function* (
      requestId: InteractionRequestId,
      params: ApprovalRequest,
      ctx: { sessionId: SessionId; branchId: BranchId },
    ) {
      // Rebuild the context reverse lookup so post-restart present() can find
      // the stored resolution by sessionId:branchId → requestId.
      const ctxKey = contextKey(ctx.sessionId, ctx.branchId)
      pendingByContext.set(ctxKey, requestId)
      // Re-publish the event so reconnecting clients render the dialog.
      yield* config.onPresent(requestId, params, ctx)
    }),
  }
}
