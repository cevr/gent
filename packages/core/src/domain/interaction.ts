import { Clock, Context, Deferred, Effect, Option, Predicate, Ref, Schema } from "effect"
import { GentPlatform } from "../runtime/gent-platform.js"
import { EventStoreError } from "./event.js"
import { BranchId, InteractionRequestId, SessionId, ToolCallId } from "./ids.js"

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
 * again — the tool re-calls approve(), takes its answer, and continues.
 *
 * No fiber blocks on a human. Interactions survive server restarts.
 *
 * A request belongs to its owner: the tool call that asked, and which of that
 * call's asks it was. An answer goes to its owner only, never to another call
 * that asks the same question. A branch shows one request at a time; the other
 * owners queue in the order they asked. An answer whose owner ends its run
 * without taking it is settled as abandoned, so the next owner in the queue
 * asks. Recovery rebuilds the owner from the stored row.
 *
 * An answer matches its question as well as its owner: a call that asks a
 * different question in the same place asks again. A call keeps the answers
 * it took until it ends, so a call that asks twice takes its first answer
 * again on the run that asks the second. A request lives no longer than its
 * turn: `endTurn` settles what is open and dismisses an unanswered dialog.
 * A native ask needs the tool call that makes it; an ask with no call and no
 * dispatching owner is refused.
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

/**
 * An ask made outside a tool call the loop dispatched. No turn parks on it and
 * nothing runs it again, so its answer would reach the next call that asks.
 */
export class InteractionOwnerMissingError extends Schema.TaggedError<InteractionOwnerMissingError>(
  "@gent/core/src/domain/interaction/InteractionOwnerMissingError",
)("InteractionOwnerMissingError", {
  message: Schema.String,
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

/**
 * Who asked: the tool call the loop dispatched, and the index of this ask
 * among that call's asks in one run. A dispatching tool's inner calls ask as
 * the dispatching call.
 */
const InteractionOwner = Schema.Struct({
  toolCallId: ToolCallId,
  occurrence: Schema.Int,
})
type InteractionOwner = typeof InteractionOwner.Type

export const InteractionRequestRecord = Schema.Struct({
  requestId: InteractionRequestId,
  sessionId: SessionId,
  branchId: BranchId,
  paramsJson: Schema.String,
  decisionJson: Schema.optional(Schema.String),
  status: InteractionRequestStatus,
  createdAt: Schema.Finite,
  /** Absent on a row stored before owners were recorded, or asked outside a step. */
  owner: Schema.optional(InteractionOwner),
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
export const { encode: encodeInteractionDecision, decode: decodeInteractionDecision } = jsonCodec(
  decisionJsonCodec,
  "interaction decision",
)

// ============================================================================
// Interaction service
// ============================================================================

/** A session branch: the scope that shows one request at a time. */
interface BranchRef {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export interface InteractionService {
  readonly present: (
    params: ApprovalRequest,
    ctx: {
      sessionId: SessionId
      branchId: BranchId
      /** Absent uses native branch replay. None starts a fresh operation. */
      resumeRequestId?: Option.Option<InteractionRequestId>
    },
  ) => Effect.Effect<
    ApprovalDecision,
    EventStoreError | InteractionPendingError | InteractionOwnerMissingError
  >
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
  /** True when this request has an answer that its owner has not taken yet. */
  readonly answered: (requestId: InteractionRequestId) => Effect.Effect<boolean>
  /**
   * The turn on this branch ended without parking. Its open request is
   * settled, an unanswered one is dismissed, and every queued place and
   * kept answer is dropped.
   */
  readonly endTurn: (branch: BranchRef) => Effect.Effect<void>
  /**
   * Rebuild a stored pending request after a restart, with its owner. An
   * unanswered one is published again for reconnecting clients. True when
   * the stored answer is ready for its owner to take.
   */
  readonly rehydrate: (record: InteractionRequestRecord) => Effect.Effect<boolean, EventStoreError>
  /**
   * Open a step on a branch; `callIds` are the calls it runs. An answer or a
   * place in the queue whose owner is not one of them is dropped by the next
   * call that asks.
   */
  readonly beginStep: (branch: BranchRef, callIds: ReadonlyArray<ToolCallId>) => Effect.Effect<void>
  /**
   * Run one call of the open step as the owner of what it asks. When the call
   * ends, an answer it did not take is settled as abandoned.
   */
  readonly ownCall: (
    branch: BranchRef,
    toolCallId: ToolCallId,
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
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
    ctx: BranchRef,
  ) => Effect.Effect<void, EventStoreError>
  /** A presented request that will never be answered: its dialog closes. */
  readonly onDismiss: (requestId: InteractionRequestId, ctx: BranchRef) => Effect.Effect<void>
  readonly storage: InteractionStorageConfig
}

/**
 * The call a step runs right now, how many times it has asked in this run,
 * and whether this run parked on an ask.
 */
class CurrentInteractionCall extends Context.Service<
  CurrentInteractionCall,
  {
    readonly toolCallId: ToolCallId
    readonly asked: Ref.Ref<number>
    readonly parked: Ref.Ref<boolean>
  }
>()("@gent/core/src/domain/interaction/CurrentInteractionCall") {}

/** The request a branch shows. Storage holds at most one pending row per branch. */
interface OpenRequest {
  readonly requestId: InteractionRequestId
  /** None: a row stored before owners were recorded. The first call to ask takes its answer. */
  readonly owner: Option.Option<InteractionOwner>
  /** The question asked; an answer goes only to an ask of the same question. */
  readonly paramsJson: string
  /** False while the row is being stored: no call parks on it or claims the slot. */
  readonly admitted: boolean
}

/** An answer a call took. The call takes it again on each later run until it ends. */
interface TakenAnswer {
  readonly owner: InteractionOwner
  readonly paramsJson: string
  readonly decision: ApprovalDecision
}

interface BranchInteractions {
  readonly open: Option.Option<OpenRequest>
  /** Owners that parked on the open request, in the order they asked. */
  readonly queue: ReadonlyArray<InteractionOwner>
  /** The calls of the step that runs now. */
  readonly running: ReadonlySet<ToolCallId>
  readonly taken: ReadonlyArray<TakenAnswer>
}

interface InteractionState {
  readonly decisions: ReadonlyMap<InteractionRequestId, ApprovalDecision>
  readonly branches: ReadonlyMap<string, BranchInteractions>
  /** Completes on the next change, for a call that waits for its turn. */
  readonly changed: Deferred.Deferred<void>
}

const emptyBranch: BranchInteractions = {
  open: Option.none(),
  queue: [],
  running: new Set(),
  taken: [],
}

const contextKey = (branch: BranchRef) => `${branch.sessionId}:${branch.branchId}`

const sameOwner = (left: InteractionOwner, right: InteractionOwner) =>
  left.toolCallId === right.toolCallId && left.occurrence === right.occurrence

/** Both absent, or both the same ask. */
const isOwner = (left: Option.Option<InteractionOwner>, right: Option.Option<InteractionOwner>) =>
  Option.match(left, {
    onNone: () => Option.isNone(right),
    onSome: (owner) => Option.exists(right, (other) => sameOwner(owner, other)),
  })

const withoutOwner = (
  queue: ReadonlyArray<InteractionOwner>,
  owner: Option.Option<InteractionOwner>,
) => queue.filter((queued) => !isOwner(Option.some(queued), owner))

const branchOf = (current: InteractionState, key: string) =>
  Option.getOrElse(Option.fromUndefinedOr(current.branches.get(key)), () => emptyBranch)

const putBranch = (
  current: InteractionState,
  key: string,
  branch: BranchInteractions,
): InteractionState => {
  const branches = new Map(current.branches)
  if (
    Option.isNone(branch.open) &&
    branch.queue.length === 0 &&
    branch.running.size === 0 &&
    branch.taken.length === 0
  )
    branches.delete(key)
  else branches.set(key, branch)
  return { ...current, branches }
}

const dropDecision = (
  current: InteractionState,
  requestId: InteractionRequestId,
): InteractionState => {
  const decisions = new Map(current.decisions)
  decisions.delete(requestId)
  return { ...current, decisions }
}

/**
 * The open request, when it is answered and its owner can no longer take
 * the answer. A row with no recorded owner is never abandoned here.
 */
const abandonedOpen = (
  current: InteractionState,
  branch: BranchInteractions,
  gone: (owner: InteractionOwner) => boolean,
) =>
  Option.filter(
    branch.open,
    (open) =>
      open.admitted && current.decisions.has(open.requestId) && Option.exists(open.owner, gone),
  )

export const makeInteractionService = (
  config: InteractionServiceConfig,
): Effect.Effect<InteractionService, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const state = yield* Ref.make<InteractionState>({
      decisions: new Map(),
      branches: new Map(),
      changed: yield* Deferred.make<void>(),
    })

    /** Wake every call that waits for its turn. */
    const signal = Effect.gen(function* () {
      const next = yield* Deferred.make<void>()
      const previous = yield* Ref.modify(
        state,
        (current): [Deferred.Deferred<void>, InteractionState] => [
          current.changed,
          { ...current, changed: next },
        ],
      )
      yield* Deferred.completeWith(previous, Effect.void)
    })

    /** The row stops being pending; a call waiting behind it may ask. */
    const settle = (requestId: InteractionRequestId) =>
      config.storage.resolve(requestId).pipe(Effect.andThen(signal))

    /** Settle an answer its owner did not take. */
    const abandon = (key: string, gone: (owner: InteractionOwner) => boolean) =>
      Effect.gen(function* () {
        const abandoned = yield* Ref.modify(
          state,
          (current): [Option.Option<InteractionRequestId>, InteractionState] => {
            const branch = branchOf(current, key)
            const open = abandonedOpen(current, branch, gone)
            if (Option.isNone(open)) return [Option.none(), current]
            const requestId = open.value.requestId
            const next = putBranch(dropDecision(current, requestId), key, {
              ...branch,
              open: Option.none(),
            })
            return [Option.some(requestId), next]
          },
        )
        if (Option.isSome(abandoned)) yield* config.storage.resolve(abandoned.value)
        yield* signal
      })

    /** This ask's owner: the running call and the index of this ask in its run. */
    const currentOwner = Effect.gen(function* () {
      const call = yield* Effect.serviceOption(CurrentInteractionCall)
      if (Option.isNone(call)) return Option.none<InteractionOwner>()
      const occurrence = yield* Ref.getAndUpdate(call.value.asked, (asked) => asked + 1)
      return Option.some({ toolCallId: call.value.toolCallId, occurrence })
    })

    /** A run that parks keeps the answers its call took for the next run. */
    const markParked = Effect.serviceOption(CurrentInteractionCall).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (call) => Ref.set(call.parked, true),
        }),
      ),
    )

    /** Store and publish a request whose slot this ask has claimed, then park on it. */
    const ask = Effect.fn("InteractionService.ask")(function* (request: {
      readonly params: ApprovalRequest
      readonly paramsJson: string
      readonly requestId: InteractionRequestId
      readonly owner: Option.Option<InteractionOwner>
      readonly branch: BranchRef
    }) {
      const key = contextKey(request.branch)
      const isClaim = (open: OpenRequest) => open.requestId === request.requestId
      // A refused row gives the slot back; the request it would have replaced
      // was never touched, because a claim needs a free slot.
      const release = Ref.update(state, (current) => {
        const branch = branchOf(current, key)
        if (!Option.exists(branch.open, isClaim)) return current
        return putBranch(current, key, { ...branch, open: Option.none() })
      }).pipe(Effect.andThen(signal))
      const record: InteractionRequestRecord = {
        requestId: request.requestId,
        sessionId: request.branch.sessionId,
        branchId: request.branch.branchId,
        paramsJson: request.paramsJson,
        status: "pending",
        createdAt: yield* Clock.currentTimeMillis,
        ...Option.match(request.owner, { onNone: () => ({}), onSome: (owner) => ({ owner }) }),
      }
      yield* config.storage.persist(record).pipe(Effect.onError(() => release))
      yield* Ref.update(state, (current) => {
        const branch = branchOf(current, key)
        const open = Option.filter(branch.open, isClaim)
        if (Option.isNone(open)) return current
        return putBranch(current, key, {
          ...branch,
          open: Option.some({ ...open.value, admitted: true }),
        })
      })
      yield* signal
      yield* config.onPresent(request.requestId, request.params, request.branch)
      // Signal the machine to park in WaitingForInteraction.
      return yield* new InteractionPendingError({
        requestId: request.requestId,
        sessionId: request.branch.sessionId,
        branchId: request.branch.branchId,
      })
    })

    type Next = Effect.Effect<
      Option.Option<ApprovalDecision>,
      EventStoreError | InteractionPendingError
    >

    /**
     * A call that asks as itself. It takes the answer it kept or the answer
     * that belongs to it, when the question is the same; it waits while
     * another running call may still take the open answer; it parks behind
     * an open question; and it asks when the slot is free and no earlier
     * owner is queued. A call never waits on itself: an open request from
     * another ask of the same call is settled. `None` from a step means look
     * again.
     */
    const presentNative = Effect.fn("InteractionService.presentNative")(function* (
      params: ApprovalRequest,
      branchRef: BranchRef,
      owner: InteractionOwner,
    ) {
      const key = contextKey(branchRef)
      const paramsJson = yield* encodeInteractionParams(params)
      const requestId = InteractionRequestId.make(yield* platform.randomId)
      const asker = Option.some(owner)
      const parkOn = (openId: InteractionRequestId): Next =>
        Effect.fail(
          new InteractionPendingError({
            requestId: openId,
            sessionId: branchRef.sessionId,
            branchId: branchRef.branchId,
          }),
        )
      type Step = [Next, InteractionState]
      const lookAgain: Next = Effect.succeedNone
      // Settle the open request and look again. An unanswered one closes its dialog.
      const drop = (
        current: InteractionState,
        branch: BranchInteractions,
        open: OpenRequest,
      ): Step => {
        const settled = putBranch(dropDecision(current, open.requestId), key, {
          ...branch,
          open: Option.none(),
        })
        let settling = settle(open.requestId)
        if (!current.decisions.has(open.requestId))
          settling = settling.pipe(Effect.andThen(config.onDismiss(open.requestId, branchRef)))
        return [Effect.as(settling, Option.none()), settled]
      }
      /** An answer this call kept from an earlier run, for the same question. */
      const fromKept = (current: InteractionState, branch: BranchInteractions) =>
        Option.map(
          Option.fromUndefinedOr(branch.taken.find((entry) => sameOwner(entry.owner, owner))),
          (kept): Step => {
            if (kept.paramsJson === paramsJson) return [Effect.succeedSome(kept.decision), current]
            // The call asks something else here now: forget the old answer.
            const taken = branch.taken.filter((entry) => entry !== kept)
            return [lookAgain, putBranch(current, key, { ...branch, taken })]
          },
        )
      /** An open question nobody answered yet: park on it, in the queue. */
      const onUnanswered = (
        current: InteractionState,
        branch: BranchInteractions,
        open: OpenRequest,
        mine: boolean,
      ): Step => {
        const queued = mine || branch.queue.some((entry) => isOwner(Option.some(entry), asker))
        if (queued) return [parkOn(open.requestId), current]
        return [
          parkOn(open.requestId),
          putBranch(current, key, { ...branch, queue: [...branch.queue, owner] }),
        ]
      }
      const onOpen = (
        current: InteractionState,
        branch: BranchInteractions,
        open: OpenRequest,
        wait: Next,
      ): Step => {
        if (!open.admitted) return [wait, current]
        const mine = isOwner(open.owner, asker)
        const sameCall = Option.exists(
          open.owner,
          (other) => other.toolCallId === owner.toolCallId && !mine,
        )
        const sameQuestion = open.paramsJson === paramsJson
        // A changed question, or another ask of this same call: this call
        // cannot take that request, and it is the only one that could.
        if ((mine && !sameQuestion) || sameCall) return drop(current, branch, open)
        const decision = current.decisions.get(open.requestId)
        if (Predicate.isUndefined(decision)) return onUnanswered(current, branch, open, mine)
        if (Option.isNone(open.owner) || mine) {
          // A row stored before owners were recorded goes to the first ask of its question.
          if (!sameQuestion) return drop(current, branch, open)
          const taken = putBranch(dropDecision(current, open.requestId), key, {
            ...branch,
            open: Option.none(),
            queue: withoutOwner(branch.queue, asker),
            taken: [...branch.taken, { owner, paramsJson, decision }],
          })
          return [Effect.as(settle(open.requestId), Option.some(decision)), taken]
        }
        if (branch.running.has(open.owner.value.toolCallId)) return [wait, current]
        // No running call can take it: settle it and look again.
        return drop(current, branch, open)
      }
      const onFree = (current: InteractionState, branch: BranchInteractions, wait: Next): Step => {
        const head = Option.fromUndefinedOr(branch.queue[0])
        if (Option.isSome(head) && !isOwner(head, asker)) {
          // An earlier owner asks first; one whose call ended lost its place.
          if (branch.running.has(head.value.toolCallId)) return [wait, current]
          return [lookAgain, putBranch(current, key, { ...branch, queue: branch.queue.slice(1) })]
        }
        const claimed = putBranch(current, key, {
          ...branch,
          open: Option.some({ requestId, owner: asker, paramsJson, admitted: false }),
          queue: withoutOwner(branch.queue, asker),
        })
        return [ask({ params, paramsJson, requestId, owner: asker, branch: branchRef }), claimed]
      }
      // A claim, once made, runs to admission or release: an interrupt in
      // between would leave the slot claimed by nobody. Only a wait for a
      // turn is interruptible.
      const look = Effect.uninterruptibleMask((restore) =>
        Effect.flatten(
          Ref.modify(state, (current): Step => {
            const branch = branchOf(current, key)
            const wait: Next = restore(Effect.as(Deferred.await(current.changed), Option.none()))
            return Option.getOrElse(fromKept(current, branch), () =>
              Option.match(branch.open, {
                onNone: () => onFree(current, branch, wait),
                onSome: (open) => onOpen(current, branch, open, wait),
              }),
            )
          }),
        ),
      )
      while (true) {
        const decided = yield* look
        if (Option.isSome(decided)) return decided.value
      }
    })

    /**
     * An inner call of a dispatching tool. Its owner keeps the request id on
     * its own receipt, so it resumes by that id. A fresh ask needs a free slot:
     * the owner cannot replay its source to ask later, so it is refused rather
     * than queued, and the open request stays as it was.
     */
    const presentOwned = Effect.fn("InteractionService.presentOwned")(function* (
      params: ApprovalRequest,
      branchRef: BranchRef,
      owner: Option.Option<InteractionOwner>,
      resume: Option.Option<InteractionRequestId>,
    ) {
      const key = contextKey(branchRef)
      if (Option.isSome(resume)) {
        const selected = resume.value
        const take = Ref.modify(
          state,
          (current): [Effect.Effect<ApprovalDecision, EventStoreError>, InteractionState] => {
            const decision = current.decisions.get(selected)
            if (Predicate.isUndefined(decision)) {
              const unavailable = new EventStoreError({
                message: "Selected interaction decision is unavailable",
              })
              return [Effect.fail(unavailable), current]
            }
            const branch = branchOf(current, key)
            let taken = dropDecision(current, selected)
            if (Option.exists(branch.open, (open) => open.requestId === selected))
              taken = putBranch(taken, key, { ...branch, open: Option.none() })
            return [Effect.as(settle(selected), decision), taken]
          },
        )
        return yield* Effect.uninterruptible(Effect.flatten(take))
      }
      const paramsJson = yield* encodeInteractionParams(params)
      const requestId = InteractionRequestId.make(yield* platform.randomId)
      type Claim = Effect.Effect<never, EventStoreError | InteractionPendingError>
      const claim = Ref.modify(state, (current): [Claim, InteractionState] => {
        const branch = branchOf(current, key)
        if (Option.isSome(branch.open)) {
          const busy = new EventStoreError({
            message: "Another interaction is open on this branch",
          })
          return [Effect.fail(busy), current]
        }
        const claimed = putBranch(current, key, {
          ...branch,
          open: Option.some({ requestId, owner, paramsJson, admitted: false }),
        })
        return [ask({ params, paramsJson, requestId, owner, branch: branchRef }), claimed]
      })
      return yield* Effect.uninterruptible(Effect.flatten(claim))
    })

    return {
      storeResolution: (requestId, decision) =>
        Effect.gen(function* () {
          const decisionJson = yield* encodeInteractionDecision(decision)
          yield* config.storage.decide(requestId, decisionJson)
          yield* Ref.update(state, (current) => ({
            ...current,
            decisions: new Map(current.decisions).set(requestId, decision),
          }))
        }),

      present: Effect.fn("InteractionService.present")(function* (
        params: ApprovalRequest,
        ctx: Parameters<InteractionService["present"]>[1],
      ) {
        const branchRef = { sessionId: ctx.sessionId, branchId: ctx.branchId }
        const owner = yield* currentOwner
        const resume = ctx.resumeRequestId
        // A dispatching owner resumes its asks by the id on its receipt.
        if (!Predicate.isUndefined(resume))
          return yield* presentOwned(params, branchRef, owner, resume).pipe(
            Effect.tapErrorTag("InteractionPendingError", () => markParked),
          )
        // A native ask outside a dispatched call has no turn to park and no
        // run to take its answer, so it is refused.
        if (Option.isNone(owner))
          return yield* new InteractionOwnerMissingError({
            message: "An interaction can only be asked from a tool call the loop runs",
          })
        return yield* presentNative(params, branchRef, owner.value).pipe(
          Effect.tapErrorTag("InteractionPendingError", () => markParked),
        )
      }),

      answered: (requestId) =>
        Ref.get(state).pipe(Effect.map((current) => current.decisions.has(requestId))),

      endTurn: (branchRef) =>
        Effect.gen(function* () {
          const key = contextKey(branchRef)
          const open = yield* Ref.modify(
            state,
            (
              current,
            ): [Option.Option<{ open: OpenRequest; answered: boolean }>, InteractionState] => {
              const branch = branchOf(current, key)
              const next = putBranch(current, key, { ...emptyBranch, running: branch.running })
              return Option.match(branch.open, {
                onNone: () => [Option.none(), next],
                onSome: (value) => [
                  Option.some({ open: value, answered: current.decisions.has(value.requestId) }),
                  dropDecision(next, value.requestId),
                ],
              })
            },
          )
          if (Option.isNone(open)) return yield* signal
          yield* settle(open.value.open.requestId)
          if (open.value.open.admitted && !open.value.answered)
            yield* config.onDismiss(open.value.open.requestId, branchRef)
        }),

      pendingRequestId: (ctx) =>
        Ref.get(state).pipe(
          Effect.map((current) =>
            Option.getOrUndefined(
              branchOf(current, contextKey(ctx)).open.pipe(
                Option.filter((open) => open.admitted),
                Option.map((open) => open.requestId),
              ),
            ),
          ),
        ),

      rehydrate: Effect.fn("InteractionService.rehydrate")(function* (
        record: InteractionRequestRecord,
      ) {
        const params = yield* decodeInteractionParams(record.paramsJson)
        const branchRef = { sessionId: record.sessionId, branchId: record.branchId }
        const key = contextKey(branchRef)
        // An answer that no longer decodes is asked again.
        const decision = yield* Option.match(Option.fromUndefinedOr(record.decisionJson), {
          onNone: () => Effect.succeedNone,
          onSome: (json) => decodeInteractionDecision(json).pipe(Effect.option),
        })
        yield* Ref.update(state, (current) => {
          const decided = Option.match(decision, {
            onNone: () => current,
            onSome: (value) => ({
              ...current,
              decisions: new Map(current.decisions).set(record.requestId, value),
            }),
          })
          return putBranch(decided, key, {
            ...branchOf(decided, key),
            open: Option.some({
              requestId: record.requestId,
              owner: Option.fromUndefinedOr(record.owner),
              paramsJson: record.paramsJson,
              admitted: true,
            }),
          })
        })
        if (Option.isSome(decision)) return true
        // Re-publish the event so reconnecting clients render the dialog.
        yield* config.onPresent(record.requestId, params, branchRef)
        return false
      }),

      // Every call of the step counts as running before any of them starts,
      // so a call that asks first waits for an earlier owner that has not
      // started yet instead of settling that owner's answer. Answers kept by
      // a call that is not in this step are dropped.
      beginStep: (branchRef, callIds) =>
        Ref.update(state, (current) => {
          const key = contextKey(branchRef)
          const running = new Set(callIds)
          const branch = branchOf(current, key)
          return putBranch(current, key, {
            ...branch,
            running,
            taken: branch.taken.filter((entry) => running.has(entry.owner.toolCallId)),
          })
        }),

      ownCall: (branchRef, toolCallId) => (self) =>
        Effect.gen(function* () {
          const key = contextKey(branchRef)
          const asked = yield* Ref.make(0)
          const parked = yield* Ref.make(false)
          // When the call ends, it gives up its place for asks it did not
          // make in this run, and an answer it did not take. A run that did
          // not park ends the call, so the answers it kept go too.
          const ended = Effect.gen(function* () {
            const count = yield* Ref.get(asked)
            const keep = yield* Ref.get(parked)
            yield* Ref.update(state, (current) => {
              const branch = branchOf(current, key)
              const running = new Set(branch.running)
              running.delete(toolCallId)
              return putBranch(current, key, {
                ...branch,
                running,
                queue: branch.queue.filter(
                  (owner) => owner.toolCallId !== toolCallId || owner.occurrence < count,
                ),
                taken: branch.taken.filter(
                  (entry) => keep || entry.owner.toolCallId !== toolCallId,
                ),
              })
            })
            yield* abandon(key, (owner) => owner.toolCallId === toolCallId)
          })
          return yield* self.pipe(
            Effect.provideService(CurrentInteractionCall, { toolCallId, asked, parked }),
            Effect.ensuring(ended),
          )
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
