import { Clock, Context, Deferred, Effect, Option, Predicate, Ref, Schema } from "effect"
import { GentPlatform } from "../runtime/gent-platform.js"
import { EventStoreError } from "./event.js"
import { BranchId, InteractionRequestId, SessionId } from "./ids.js"

// ── interaction-request ─────────────────────────────────────────────────────

/**
 * Cold interaction mechanics.
 *
 * Tools call `ctx.interaction.approve({ text, metadata? })` to request human input.
 * The approval service generates a requestId, persists to storage,
 * publishes InteractionPresented, then fails with InteractionPendingError.
 * The agent loop machine catches this and parks in WaitingForInteraction.
 *
 * When the client responds, the resolution `{ approved, notes?, editedContent? }` is stored
 * keyed by requestId. The loop leaves WaitingForInteraction and runs the step
 * again — the tool re-calls approve(), finds the stored resolution, and continues.
 *
 * No fiber blocks on a human. Interactions survive server restarts. A branch has
 * one open request at a time; see `presentNative`.
 */

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
  editedContent: Schema.optional(Schema.String),
})
export type ApprovalDecision = Schema.Schema.Type<typeof ApprovalDecisionSchema>

// ============================================================================
// Interaction pending signal
// ============================================================================

export class InteractionPendingError extends Schema.TaggedError<InteractionPendingError>(
  "@gent/core/src/domain/interaction/InteractionPendingError",
)("InteractionPendingError", {
  requestId: InteractionRequestId,
  sessionId: SessionId,
  branchId: BranchId,
}) {}

export class InteractionRequestMismatchError extends Schema.TaggedError<InteractionRequestMismatchError>(
  "@gent/core/src/domain/interaction/InteractionRequestMismatchError",
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
  sessionId: SessionId,
  branchId: BranchId,
  paramsJson: Schema.String,
  decisionJson: Schema.optional(Schema.String),
  status: InteractionRequestStatus,
  createdAt: Schema.Finite,
})
export type InteractionRequestRecord = typeof InteractionRequestRecord.Type

const interactionJsonCodec = Schema.fromJsonString(ApprovalRequestSchema)
const decisionJsonCodec = Schema.fromJsonString(ApprovalDecisionSchema)

const jsonCodec = <A>(codec: Schema.Codec<A, string>, label: string) => ({
  encode: (value: A): Effect.Effect<string, EventStoreError> =>
    Schema.encodeEffect(codec)(value).pipe(
      Effect.mapError(
        (cause) => new EventStoreError({ message: `Failed to encode ${label}`, cause }),
      ),
    ),
  decode: (json: string): Effect.Effect<A, EventStoreError> =>
    Schema.decodeEffect(codec)(json).pipe(
      Effect.mapError(
        (cause) => new EventStoreError({ message: `Failed to decode ${label}`, cause }),
      ),
    ),
})

const { encode: encodeInteractionParams, decode: decodeInteractionParams } = jsonCodec(
  interactionJsonCodec,
  "interaction params",
)
export { decodeInteractionParams }
export const { encode: encodeInteractionDecision, decode: decodeInteractionDecision } = jsonCodec(
  decisionJsonCodec,
  "interaction decision",
)

// ============================================================================
// Interaction service
// ============================================================================

export interface InteractionService {
  readonly present: (
    params: ApprovalRequest,
    ctx: {
      sessionId: SessionId
      branchId: BranchId
      /** Absent uses native branch replay. None starts a fresh operation. */
      resumeRequestId?: Option.Option<InteractionRequestId>
    },
  ) => Effect.Effect<ApprovalDecision, EventStoreError | InteractionPendingError>
  readonly pendingRequestId: (ctx: {
    sessionId: SessionId
    branchId: BranchId
    // oxlint-disable-next-line effect/noNullish -- The public interaction lookup preserves undefined for no pending request.
  }) => Effect.Effect<InteractionRequestId | undefined>
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

interface InteractionServiceConfig {
  readonly onPresent: (
    requestId: InteractionRequestId,
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
  ) => Effect.Effect<void, EventStoreError>
  readonly storage: InteractionStorageConfig
}

/** The one request a branch is waiting on. */
interface PendingInteraction {
  readonly requestId: InteractionRequestId
  /** The encoded request; only a call asking the same thing takes its answer. */
  readonly paramsJson: string
  /** Completes when the answer is taken, so a call waiting behind it can ask next. */
  readonly taken: Deferred.Deferred<void>
}

interface InteractionState {
  readonly storedResolutions: ReadonlyMap<InteractionRequestId, ApprovalDecision>
  /** sessionId:branchId → the request that branch waits on (at most one; storage enforces it) */
  readonly pendingByContext: ReadonlyMap<string, PendingInteraction>
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

    const setPending = (ctxKey: string, pending: PendingInteraction) =>
      Ref.update(state, (current) => ({
        ...current,
        pendingByContext: new Map(current.pendingByContext).set(ctxKey, pending),
      }))

    /** Drop a settled or abandoned request and wake the calls waiting behind it. */
    const release = (ctxKey: string, requestId: InteractionRequestId) =>
      Effect.gen(function* () {
        const released = yield* Ref.modify(state, (current) => {
          const storedResolutions = new Map(current.storedResolutions)
          storedResolutions.delete(requestId)
          const pendingByContext = new Map(current.pendingByContext)
          const entry = Option.fromUndefinedOr(pendingByContext.get(ctxKey)).pipe(
            Option.filter((pending) => pending.requestId === requestId),
          )
          if (Option.isSome(entry)) pendingByContext.delete(ctxKey)
          return [entry, { storedResolutions, pendingByContext }]
        })
        if (Option.isSome(released)) yield* Deferred.completeWith(released.value.taken, Effect.void)
      })

    const contextKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

    /** Persist and publish a fresh request that this call now owns, then park. */
    const ask = Effect.fn("InteractionService.ask")(function* (
      params: ApprovalRequest,
      paramsJson: string,
      requestId: InteractionRequestId,
      ctx: { sessionId: SessionId; branchId: BranchId },
    ) {
      const ctxKey = contextKey(ctx.sessionId, ctx.branchId)
      // Persist to storage before publishing event (crash-safe)
      yield* config.storage
        .persist({
          requestId,
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          paramsJson,
          status: "pending",
          createdAt: yield* Clock.currentTimeMillis,
        })
        .pipe(Effect.onError(() => release(ctxKey, requestId)))
      yield* config.onPresent(requestId, params, ctx)
      // Signal the machine to park in WaitingForInteraction.
      return yield* new InteractionPendingError({
        requestId,
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
      })
    })

    /**
     * A direct tool call. One request per branch is open at a time: a second
     * call in the same step parks on the open one, and when the step runs
     * again after the answer, it waits until the first call takes that
     * answer, then asks its own question.
     */
    const presentNative = Effect.fn("InteractionService.presentNative")(function* (
      params: ApprovalRequest,
      ctx: { sessionId: SessionId; branchId: BranchId },
    ) {
      const ctxKey = contextKey(ctx.sessionId, ctx.branchId)
      const paramsJson = yield* encodeInteractionParams(params)
      const requestId = InteractionRequestId.make(yield* platform.randomId)
      const taken = yield* Deferred.make<void>()
      // `None` means the open request's answer belongs to another call: wait
      // for that call to take it, then decide again.
      type Next = Effect.Effect<
        Option.Option<ApprovalDecision>,
        EventStoreError | InteractionPendingError
      >
      while (true) {
        const next = yield* Ref.modify(state, (current): [Next, InteractionState] => {
          const entry = current.pendingByContext.get(ctxKey)
          if (Predicate.isUndefined(entry)) {
            const pendingByContext = new Map(current.pendingByContext).set(ctxKey, {
              requestId,
              paramsJson,
              taken,
            })
            return [ask(params, paramsJson, requestId, ctx), { ...current, pendingByContext }]
          }
          const decision = current.storedResolutions.get(entry.requestId)
          if (Predicate.isUndefined(decision)) {
            // Park on the open request; this call asks after it is answered.
            const parked = new InteractionPendingError({
              requestId: entry.requestId,
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
            })
            return [Effect.fail(parked), current]
          }
          if (entry.paramsJson !== paramsJson) {
            return [Effect.as(Deferred.await(entry.taken), Option.none()), current]
          }
          const storedResolutions = new Map(current.storedResolutions)
          storedResolutions.delete(entry.requestId)
          const pendingByContext = new Map(current.pendingByContext)
          pendingByContext.delete(ctxKey)
          const take = config.storage
            .resolve(entry.requestId)
            .pipe(
              Effect.andThen(Deferred.completeWith(entry.taken, Effect.void)),
              Effect.as(Option.some(decision)),
            )
          return [take, { storedResolutions, pendingByContext }]
        })
        const decided = yield* next
        if (Option.isSome(decided)) return decided.value
      }
    })

    return {
      storeResolution: (requestId, decision) =>
        Effect.gen(function* () {
          const decisionJson = yield* encodeInteractionDecision(decision)
          yield* config.storage.decide(requestId, decisionJson)
          yield* setResolution(requestId, decision)
        }),

      present: Effect.fn("InteractionService.present")(function* (
        params: ApprovalRequest,
        ctx: Parameters<InteractionService["present"]>[1],
      ) {
        if (Predicate.isUndefined(ctx.resumeRequestId)) return yield* presentNative(params, ctx)
        // An owning call names the request it resumes, or starts a fresh one.
        const ctxKey = contextKey(ctx.sessionId, ctx.branchId)
        const selected = ctx.resumeRequestId
        if (Option.isSome(selected)) {
          const decision = (yield* Ref.get(state)).storedResolutions.get(selected.value)
          if (Predicate.isUndefined(decision)) {
            return yield* new EventStoreError({
              message: "Selected interaction decision is unavailable",
            })
          }
          yield* release(ctxKey, selected.value)
          yield* config.storage.resolve(selected.value)
          return decision
        }
        const paramsJson = yield* encodeInteractionParams(params)
        const requestId = InteractionRequestId.make(yield* platform.randomId)
        yield* setPending(ctxKey, { requestId, paramsJson, taken: yield* Deferred.make<void>() })
        return yield* ask(params, paramsJson, requestId, ctx)
      }),

      pendingRequestId: (ctx) =>
        Ref.get(state).pipe(
          Effect.map((current) =>
            Option.getOrUndefined(
              Option.map(
                Option.fromUndefinedOr(
                  current.pendingByContext.get(contextKey(ctx.sessionId, ctx.branchId)),
                ),
                (pending) => pending.requestId,
              ),
            ),
          ),
        ),

      rehydrate: Effect.fn("InteractionService.rehydrate")(function* (
        requestId: InteractionRequestId,
        params: ApprovalRequest,
        ctx: { sessionId: SessionId; branchId: BranchId },
        decision?: ApprovalDecision,
      ) {
        // Rebuild the context reverse lookup so post-restart present() can find
        // the stored resolution by sessionId:branchId → requestId.
        const ctxKey = contextKey(ctx.sessionId, ctx.branchId)
        const paramsJson = yield* encodeInteractionParams(params)
        yield* setPending(ctxKey, { requestId, paramsJson, taken: yield* Deferred.make<void>() })
        if (!Predicate.isUndefined(decision)) {
          yield* setResolution(requestId, decision)
          return
        }
        // Re-publish the event so reconnecting clients render the dialog.
        yield* config.onPresent(requestId, params, ctx)
      }),
    }
  })

// ── interaction-owner ───────────────────────────────────────────────────────

/**
 * Who owns the interaction being presented right now.
 *
 * A tool that dispatches other tools inside itself owns their interactions: an
 * approval raised by an inner call belongs to the dispatcher's receipt, not to
 * the branch's native replay, and must be persisted and resumed through it.
 *
 * Core does not know which tools dispatch, so it does not try to answer that
 * question. A dispatcher provides this service for the duration of an inner
 * call; when it is absent — the common case — interactions take the native
 * branch path.
 */

export interface InteractionOwnership {
  /** The session and branch the owning call belongs to. */
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /**
   * Persist a request against the owner's receipt instead of the branch store.
   */
  readonly persist: (record: InteractionRequestRecord) => Effect.Effect<void, EventStoreError>
  /**
   * The request id to resume, for an owner that is mid-approval.
   *
   * `None` starts a fresh interaction. A failure means the owner is not in a
   * state that can take one.
   */
  readonly resumeRequestId: Effect.Effect<Option.Option<InteractionRequestId>, EventStoreError>
}

export class CurrentInteractionOwner extends Context.Service<
  CurrentInteractionOwner,
  InteractionOwnership
>()("@gent/core/src/domain/interaction/CurrentInteractionOwner") {}
