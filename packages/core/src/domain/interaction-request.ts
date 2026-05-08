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

import { Clock, Effect, Ref, Schema } from "effect"
import { GentPlatform } from "../runtime/gent-platform.js"
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

export const InteractionRequestStatus = Schema.Literals(["pending", "resolved"])
export type InteractionRequestStatus = typeof InteractionRequestStatus.Type

export const InteractionRequestRecord = Schema.Struct({
  requestId: InteractionRequestId,
  type: Schema.String,
  sessionId: SessionId,
  branchId: BranchId,
  paramsJson: Schema.String,
  decisionJson: Schema.optional(Schema.String),
  status: InteractionRequestStatus,
  createdAt: Schema.Number,
})
export type InteractionRequestRecord = typeof InteractionRequestRecord.Type

/** All interaction records use this type — the old per-handler types are gone */
export const INTERACTION_TYPE = "approval" as const

const interactionJsonCodec = Schema.fromJsonString(ApprovalRequestSchema)
const decisionJsonCodec = Schema.fromJsonString(ApprovalDecisionSchema)

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

export const encodeInteractionDecision = (
  decision: ApprovalDecision,
): Effect.Effect<string, EventStoreError> =>
  Schema.encodeEffect(decisionJsonCodec)(decision).pipe(
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: "Failed to encode interaction decision",
          cause,
        }),
    ),
  )

export const decodeInteractionDecision = (
  decisionJson: string,
): Effect.Effect<ApprovalDecision, EventStoreError> =>
  Schema.decodeUnknownEffect(decisionJsonCodec)(decisionJson).pipe(
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: "Failed to decode interaction decision",
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
  }) => Effect.Effect<InteractionRequestId | undefined>
  readonly respond: (requestId: InteractionRequestId) => Effect.Effect<void, EventStoreError>
  /** Store a resolution for cold-mode resumption (keyed by requestId) */
  readonly storeResolution: (
    requestId: InteractionRequestId,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, EventStoreError>
  /** Re-publish event for a persisted pending request (recovery after restart) */
  readonly rehydrate: (
    requestId: InteractionRequestId,
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
    decision?: ApprovalDecision,
  ) => Effect.Effect<void, EventStoreError>
}

/**
 * Storage callbacks for durable interaction requests.
 * Persist failures fail closed. A presented interaction without a durable row
 * strands recovery and breaks the pending singleton invariant.
 */
export interface InteractionStorageConfig {
  readonly persist: (record: InteractionRequestRecord) => Effect.Effect<void, EventStoreError>
  readonly decide: (
    requestId: InteractionRequestId,
    decisionJson: string,
  ) => Effect.Effect<void, EventStoreError>
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

interface InteractionState {
  readonly storedResolutions: ReadonlyMap<InteractionRequestId, ApprovalDecision>
  /** Reverse lookup: sessionId:branchId → requestId (at most one pending per session+branch) */
  readonly pendingByContext: ReadonlyMap<string, InteractionRequestId>
}

export const makeInteractionService = (
  config: InteractionServiceConfig,
): Effect.Effect<InteractionService, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const state = yield* Ref.make<InteractionState>({
      storedResolutions: new Map(),
      pendingByContext: new Map(),
    })

    const setResolution = (requestId: InteractionRequestId, decision: ApprovalDecision) =>
      Ref.update(state, (current) => ({
        ...current,
        storedResolutions: new Map(current.storedResolutions).set(requestId, decision),
      }))

    const takeStoredResolution = (ctxKey: string) =>
      Ref.modify(state, (current) => {
        const requestId = current.pendingByContext.get(ctxKey)
        if (requestId === undefined) return [undefined, current]

        const decision = current.storedResolutions.get(requestId)
        if (decision === undefined) return [undefined, current]

        const storedResolutions = new Map(current.storedResolutions)
        storedResolutions.delete(requestId)
        const pendingByContext = new Map(current.pendingByContext)
        pendingByContext.delete(ctxKey)

        return [
          { requestId, decision },
          {
            storedResolutions,
            pendingByContext,
          },
        ]
      })

    const setPending = (ctxKey: string, requestId: InteractionRequestId) =>
      Ref.update(state, (current) => ({
        ...current,
        pendingByContext: new Map(current.pendingByContext).set(ctxKey, requestId),
      }))

    const contextKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

    return {
      storeResolution: (requestId, decision) =>
        Effect.gen(function* () {
          if (config.storage !== undefined) {
            const decisionJson = yield* encodeInteractionDecision(decision)
            yield* config.storage.decide(requestId, decisionJson)
          }
          yield* setResolution(requestId, decision)
        }),

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
        const stored = yield* takeStoredResolution(ctxKey)
        if (stored !== undefined) {
          if (config.storage !== undefined) {
            yield* config.storage.resolve(stored.requestId)
          }
          return stored.decision
        }

        const requestId = InteractionRequestId.make(yield* platform.randomId)

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
        yield* setPending(ctxKey, requestId)

        yield* config.onPresent(requestId, params, ctx)

        // Signal the machine to park in WaitingForInteraction.
        return yield* new InteractionPendingError({
          requestId,
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
        })
      }),

      pendingRequestId: (ctx) =>
        Ref.get(state).pipe(
          Effect.map((current) =>
            current.pendingByContext.get(contextKey(ctx.sessionId, ctx.branchId)),
          ),
        ),

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
        decision?: ApprovalDecision,
      ) {
        // Rebuild the context reverse lookup so post-restart present() can find
        // the stored resolution by sessionId:branchId → requestId.
        const ctxKey = contextKey(ctx.sessionId, ctx.branchId)
        yield* setPending(ctxKey, requestId)
        if (decision !== undefined) {
          yield* setResolution(requestId, decision)
          return
        }
        // Re-publish the event so reconnecting clients render the dialog.
        yield* config.onPresent(requestId, params, ctx)
      }),
    }
  })
