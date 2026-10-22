import { type Context, DateTime, Effect, Match, Option, Predicate, Schema } from "effect"
import { type AgentEvent, ContextRenter } from "./event.js"
import {
  Message,
  MessageMetadata,
  QueueSnapshot,
  RequesterBranch,
  type SessionAdmission,
  SteerCommand,
} from "./message.js"
import {
  ActorCommandId,
  BranchId,
  CredentialSlot,
  ExtensionId,
  InteractionRequestId,
  type InteractionRequestId as InteractionRequestIdType,
  MessageId,
  RequestId,
  SessionId,
  CurrentWorkspaceId,
  WorkspaceId,
} from "./ids.js"
import { ModelAttempts, ModelId, ProviderId, ReasoningEffort } from "./agent.js"
import { CredentialReceipt } from "./driver.js"
import { WakeCause, WakeNext } from "./extension.js"
import { omitUndefined } from "./guards.js"
import { RequestReply } from "./capability.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import * as Prompt from "effect/ai/Prompt"
import { Actor } from "effect-encore"

// ── state ───────────────────────────────────────────────────────────────────

export class AgentLoopError extends Schema.TaggedError<
  AgentLoopError,
  { readonly brand: unique symbol }
>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The branch refused a follow-up because its queue is at the cap. A refusal,
 * not a fault: the loop and its running turn go on untouched.
 */
export class FollowUpQueueFull extends Schema.TaggedError<
  FollowUpQueueFull,
  { readonly brand: unique symbol }
>()("FollowUpQueueFull", { max: Schema.Int }) {
  override get message(): string {
    return `Follow-up queue full (max ${this.max})`
  }
}

/** What an admission can fail with: a loop fault, or the queue's refusal. */
const AdmissionError = Schema.Union([AgentLoopError, FollowUpQueueFull])

/**
 * A storage or transport fault becomes the loop's one caller-facing error at
 * the call that raised it, keeping what actually went wrong as the cause.
 */
export const asAgentLoopError = (message: string) =>
  Effect.mapError((cause: unknown) => new AgentLoopError({ message, cause }))

// ── Shared field groups ─────────────────────────────────────────────────────

const RunningTurnFields = {
  message: Message,
  startedAtMs: Schema.Finite,
}

// ── Phase-tagged loop state (flat, actor-owned) ─────────────────────────────
//
// The loop is one fiber plus this Ref. While the actor entity is
// materialized, this enum is the source of truth for "where is the loop?".

export const LoopState = Schema.TaggedUnion({
  /** No turn in progress. */
  Idle: {},
  /** Agentic loop running: resolve → stream → tools → repeat. */
  Running: RunningTurnFields,
  /** Cold state: a tool requested human approval. No turn fiber. */
  WaitingForInteraction: {
    ...RunningTurnFields,
    pendingRequestId: InteractionRequestId,
  },
})

// ── Type aliases ────────────────────────────────────────────────────────────

export type LoopState = Schema.Schema.Type<typeof LoopState>
type IdleState = Extract<LoopState, { _tag: "Idle" }>
export type RunningState = Extract<LoopState, { _tag: "Running" }>
export type WaitingForInteractionState = Extract<LoopState, { _tag: "WaitingForInteraction" }>

// ── Runtime projection (transport/UI) ───────────────────────────────────────
// Public runtime state mirrors the machine directly. No parallel `phase/status`
// matrix — the discriminator is the state. Owned here so the public projection
// has a single canonical declaration; `protocol.ts` re-exports.

export const SessionRuntimeStateSchema = Schema.TaggedUnion({
  Idle: {
    queue: QueueSnapshot,
  },
  /** `startedAtMs`: when the current turn began, so a woken loop reads its run time, not its age. */
  Running: {
    queue: QueueSnapshot,
    startedAtMs: Schema.Finite,
  },
  WaitingForInteraction: {
    queue: QueueSnapshot,
    startedAtMs: Schema.Finite,
  },
})
export type SessionRuntimeState = Schema.Schema.Type<typeof SessionRuntimeStateSchema>

/** The latest model-context projection for the branch, folded from `ModelContextProjected`. */
export const ModelContextMetrics = Schema.Struct({
  estimatedTokens: Schema.Natural,
  availableInputTokens: Schema.Natural,
  contextLimitTokens: Schema.Natural,
  omittedMessages: Schema.Natural,
  /** The handoff marker leading the current window; absent after a summary-free window. */
  handoffMessageId: Schema.optional(MessageId),
  /** Projections on this branch that compacted history so far. */
  compactions: Schema.Natural,
  /** The held items that have cost the most so far, the costliest first. */
  renters: Schema.Array(ContextRenter),
})
export type ModelContextMetrics = typeof ModelContextMetrics.Type

export const SessionRuntimeMetrics = Schema.Struct({
  turns: Schema.Finite,
  durationMs: Schema.Finite,
  /** Cumulative USD cost: sum of `StreamEnded.costUsd`, of the compaction
   * summaries' `ModelContextProjected.costUsd` and of the routes'
   * `ModelRouted.costUsd` across the session's event
   * log. Cost is frozen into each event at emit time against the
   * pricing snapshot available then, so replays always sum to the same
   * total regardless of later registry refreshes. */
  costUsd: Schema.Finite,
  /** Input tokens the provider reported for the step the current `context`
   * projection shaped (for "how close to the context window are we right
   * now" — sums don't answer that). 0 until that step's `StreamEnded`, so a
   * count is never divided by another model's window after a switch. */
  lastInputTokens: Schema.Finite,
  context: Schema.optional(ModelContextMetrics),
  /** The newest route of a virtual model (`ModelRouted`): what the status row shows. */
  routed: Schema.optional(
    Schema.Struct({
      selected: ModelId,
      model: ModelId,
      effort: Schema.optional(ReasoningEffort),
      reason: Schema.String,
      fallback: Schema.optional(Schema.Boolean),
    }),
  ),
  /**
   * The newest effort route of `/effort auto` (`ModelRouted.effortOnly`):
   * the level it picked for the model it ran on, absent when the turn named
   * none. A model route's `routed` stays as it was.
   */
  effortRouted: Schema.optional(
    Schema.Struct({
      model: ModelId,
      effort: Schema.optional(ReasoningEffort),
      reason: Schema.String,
      fallback: Schema.optional(Schema.Boolean),
    }),
  ),
  /**
   * The effort the running turn's requests go out at, from its newest
   * `StreamStarted`: a turn keeps the level of its first step, so a level set
   * while it runs takes effect at the next turn. `level` is absent when the
   * request names none. Absent once the turn completes.
   */
  turnEffort: Schema.optional(Schema.Struct({ level: Schema.optional(ReasoningEffort) })),
  /**
   * The running turn's model-call budget, from its newest step's receipt
   * (`StreamEnded.modelAttempts`): what it used of its limit. Absent for a
   * turn with no budget, before its first step ends, and once it completes:
   * the next turn starts a budget of its own.
   */
  turnModelAttempts: Schema.optional(ModelAttempts),
  /**
   * The credential of the newest step that ended on a model
   * (`StreamEnded.credential`): what the status row names when a sign-in has
   * more than one. `receipt` is absent for a model no provider credential
   * serves; that step's credential is unknown. Absent until a step ends on a
   * model.
   */
  lastCredential: Schema.optional(
    Schema.Struct({ model: ModelId, receipt: Schema.optional(CredentialReceipt) }),
  ),
  /**
   * The branch's newest placement of a spread run (`CredentialAssigned`):
   * the account its turns walk from. Absent for a run never placed.
   */
  placement: Schema.optional(Schema.Struct({ provider: ProviderId, slot: CredentialSlot })),
  /**
   * The model and effort of the branch's newest step, from its
   * `StreamStarted`: what an agents listing names a row by, set while the
   * step runs. `effort` is absent when the request named no level. Absent
   * until a step starts.
   */
  lastStep: Schema.optional(
    Schema.Struct({ model: ModelId, effort: Schema.optional(ReasoningEffort) }),
  ),
})
export type SessionRuntimeMetrics = typeof SessionRuntimeMetrics.Type

/**
 * The account a session runs on, and why: `pinned` by its run spec
 * (`RunSpec.credentialSlot`), `assigned` by a placement of its spread
 * sign-in, or `walked` down its sign-in's order. `provider` is absent for a
 * pin that no step has gone out on yet.
 */
export const SessionAccount = Schema.Struct({
  provider: Schema.optional(ProviderId),
  slot: CredentialSlot,
  placement: Schema.Literals(["pinned", "assigned", "walked"]),
})
export type SessionAccount = typeof SessionAccount.Type

/**
 * The session's account, from its admission and its folded metrics: the
 * pin when the admission names one; else the last step's credential,
 * `assigned` when the newest placement names it and `walked` when not; else
 * none. A placement alone names no account: it is written with the receipt
 * of a request on it, so a last step with no credential (its selection
 * failed) leaves the account unknown, never the older placement's.
 */
export const sessionAccount = (
  admission: Option.Option<SessionAdmission>,
  metrics: SessionRuntimeMetrics,
): Option.Option<SessionAccount> => {
  const receipt = Option.fromUndefinedOr(metrics.lastCredential?.receipt)
  const placement = Option.fromUndefinedOr(metrics.placement)
  const pin = Option.flatMap(admission, (admitted) =>
    Option.fromUndefinedOr(admitted.runSpec?.credentialSlot),
  )
  if (Option.isSome(pin)) {
    const provider = Option.getOrUndefined(
      Option.map(
        Option.filter(receipt, (last) => last.slot === pin.value),
        (last) => last.provider,
      ),
    )
    return Option.some({ slot: pin.value, placement: "pinned", ...omitUndefined({ provider }) })
  }
  if (Option.isSome(receipt)) {
    const { provider, slot } = receipt.value
    const assigned = Option.exists(
      placement,
      (placed) => placed.provider === provider && placed.slot === slot,
    )
    if (assigned) return Option.some({ provider, slot, placement: "assigned" })
    return Option.some({ provider, slot, placement: "walked" })
  }
  return Option.none()
}

// ── State builders ──────────────────────────────────────────────────────────

/** The totals of a branch with no events. */
export const initialSessionMetrics: SessionRuntimeMetrics = {
  turns: 0,
  durationMs: 0,
  costUsd: 0,
  lastInputTokens: 0,
}

/**
 * The events the metrics read; every other event leaves them as they were.
 * Folding only these gives the totals the whole log gives, so a listing of
 * many branches reads these and not each branch's log
 * (`EventStorage.listBranchEvents`). `stepSessionMetrics` switches over
 * exactly this list: a case outside it, or a tag here without a case, does
 * not compile.
 */
export const SESSION_METRIC_TAGS = [
  "StreamStarted",
  "TurnCompleted",
  "ModelContextProjected",
  "ModelRouted",
  "StreamEnded",
  "CredentialAssigned",
] as const satisfies ReadonlyArray<AgentEvent["_tag"]>
type SessionMetricEvent = Extract<
  AgentEvent,
  { readonly _tag: (typeof SESSION_METRIC_TAGS)[number] }
>
const sessionMetricTags: ReadonlySet<string> = new Set(SESSION_METRIC_TAGS)
const isSessionMetricEvent = (event: AgentEvent): event is SessionMetricEvent =>
  sessionMetricTags.has(event._tag)

/**
 * The totals after one more event. The server folds a branch's stored log
 * with it (`foldSessionMetrics`); a client applies it to each live event on
 * top of the snapshot it hydrated, so both read one fold (decided by
 * derive-dont-sync).
 */
export const stepSessionMetrics = (
  metrics: SessionRuntimeMetrics,
  event: AgentEvent,
): SessionRuntimeMetrics => {
  if (!isSessionMetricEvent(event)) return metrics
  const addCost = (costUsd: Option.Option<number>) =>
    metrics.costUsd + Option.getOrElse(costUsd, () => 0)
  return Match.type<SessionMetricEvent>().pipe(
    Match.tagsExhaustive({
      StreamStarted: (started): SessionRuntimeMetrics => ({
        ...metrics,
        turnEffort: omitUndefined({ level: started.reasoningLevel }),
        lastStep: { model: started.model, ...omitUndefined({ effort: started.reasoningLevel }) },
      }),
      TurnCompleted: (completed): SessionRuntimeMetrics => {
        const { turnEffort: _ended, turnModelAttempts: _spent, ...idle } = metrics
        return {
          ...idle,
          turns: metrics.turns + 1,
          durationMs: metrics.durationMs + completed.durationMs,
        }
      },
      ModelContextProjected: (projected): SessionRuntimeMetrics => {
        let compactions = Option.getOrElse(
          Option.map(Option.fromUndefinedOr(metrics.context), (context) => context.compactions),
          () => 0,
        )
        if (projected.compacted) compactions += 1
        return {
          ...metrics,
          costUsd: addCost(Option.fromUndefinedOr(projected.costUsd)),
          // A new step's projection: the last count belongs to the step before it.
          lastInputTokens: 0,
          context: {
            estimatedTokens: projected.estimatedTokens,
            availableInputTokens: projected.availableInputTokens,
            contextLimitTokens: projected.contextLimitTokens,
            omittedMessages: projected.omittedMessages,
            handoffMessageId: projected.handoffMessageId,
            compactions,
            renters: projected.renters,
          },
        }
      },
      ModelRouted: (routed): SessionRuntimeMetrics => {
        const route = {
          model: routed.model,
          reason: routed.reason,
          ...omitUndefined({ effort: routed.effort, fallback: routed.fallback }),
        }
        const costUsd = addCost(Option.fromUndefinedOr(routed.costUsd))
        if (routed.effortOnly === true) return { ...metrics, costUsd, effortRouted: route }
        return { ...metrics, costUsd, routed: { selected: routed.selected, ...route } }
      },
      StreamEnded: (ended): SessionRuntimeMetrics => {
        const next = {
          ...metrics,
          costUsd: addCost(Option.fromUndefinedOr(ended.costUsd)),
          lastInputTokens: Option.match(Option.fromUndefinedOr(ended.usage), {
            onNone: () => metrics.lastInputTokens,
            onSome: (usage) => usage.inputTokens,
          }),
          ...omitUndefined({ turnModelAttempts: ended.modelAttempts }),
        }
        // A step that ended on no model (a failed request) leaves the last one.
        if (Predicate.isUndefined(ended.model)) return next
        return {
          ...next,
          lastCredential: { model: ended.model, ...omitUndefined({ receipt: ended.credential }) },
        }
      },
      CredentialAssigned: (assigned): SessionRuntimeMetrics => ({
        ...metrics,
        placement: { provider: assigned.provider, slot: assigned.slot },
      }),
    }),
  )(event)
}

/** Session totals read off the branch's event log; one pass, no storage. */
export const foldSessionMetrics = (
  events: ReadonlyArray<{ readonly event: AgentEvent }>,
): SessionRuntimeMetrics =>
  events.reduce((metrics, { event }) => stepSessionMetrics(metrics, event), initialSessionMetrics)

export const buildIdleState = (): IdleState => LoopState.cases.Idle.make({})

/**
 * The fields a phase carries over from whatever admitted it. Structural, so
 * this module never has to know about the inbox that holds the item.
 */
type TurnOrigin = {
  readonly message: Message
}

export const buildRunningState = (
  item: TurnOrigin,
  options: { startedAtMs: number },
): RunningState =>
  LoopState.cases.Running.make({
    message: item.message,
    startedAtMs: options.startedAtMs,
  })

export const toWaitingForInteractionState = (params: {
  state: RunningState
  pendingRequestId: InteractionRequestIdType
}): WaitingForInteractionState =>
  LoopState.cases.WaitingForInteraction.make({
    message: params.state.message,
    startedAtMs: params.state.startedAtMs,
    pendingRequestId: params.pendingRequestId,
  })

// ── entity-id ───────────────────────────────────────────────────────────────

/*
 * Reversible entity-id encoding for the AgentLoop actor.
 *
 * Encore's `Entity.toLayer` keys entities by a `string` `entityId`. Per-actor
 * state lives behind that string, so the encoding must:
 *   - Round-trip uniquely for any `(workspaceId, sessionId, branchId)` tuple
 *   - Be parseable from `CurrentAddress.entityId` inside the actor handler
 *
 * `SessionId` and `BranchId` are unconstrained branded strings, so a plain
 * `${sessionId}:${branchId}` join collides on `:`:
 *
 *     encodeRaw("a:", "x")  === "a::x"
 *     encodeRaw("a", ":x")  === "a::x"  // collision
 *
 * `encodeURIComponent` encodes both `:` and `/`, leaving the encoded
 * components free of separators. Use `:` as the separator on encoded
 * components.
 */

/** Encode `(workspaceId, sessionId, branchId)` into a unique reversible string. */
export const entityIdOf = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  branchId: BranchId,
): string =>
  `${encodeURIComponent(workspaceId)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(branchId)}`

/** Parse an encoded entity id back into its `(workspaceId, sessionId, branchId)` tuple. */
export const parseEntityId = (
  entityId: string,
): Effect.Effect<
  { workspaceId: WorkspaceId; sessionId: SessionId; branchId: BranchId },
  AgentLoopError
> =>
  Effect.gen(function* () {
    const firstSep = entityId.indexOf(":")
    let secondSep = -1
    if (firstSep >= 0) secondSep = entityId.indexOf(":", firstSep + 1)
    if (firstSep < 0 || secondSep < 0) {
      return yield* new AgentLoopError({
        message: `Invalid entity id (expected workspace/session/branch): ${entityId}`,
      })
    }
    const workspaceId = yield* decodeComponent(WorkspaceId, "workspaceId")(
      entityId.slice(0, firstSep),
      entityId,
    )
    const sessionId = yield* decodeComponent(SessionId, "sessionId")(
      entityId.slice(firstSep + 1, secondSep),
      entityId,
    )
    const branchId = yield* decodeComponent(BranchId, "branchId")(
      entityId.slice(secondSep + 1),
      entityId,
    )
    return {
      workspaceId,
      sessionId,
      branchId,
    }
  })

/** Percent-decode one entity-id component, then decode it with its schema. */
const decodeComponent =
  <A>(schema: Schema.Codec<A, string>, label: string) =>
  (raw: string, entityId: string): Effect.Effect<A, AgentLoopError> =>
    Effect.try({
      try: () => decodeURIComponent(raw),
      catch: () =>
        new AgentLoopError({ message: `Invalid entity id (${label} decode): ${entityId}` }),
    }).pipe(
      Effect.flatMap((decoded) =>
        Schema.decodeEffect(schema)(decoded).pipe(
          asAgentLoopError(`Invalid entity id (${label} schema): ${entityId}`),
        ),
      ),
    )

/**
 * Enumerate the materialized loops belonging to one workspace.
 *
 * The actor registry is keyed by opaque entity id across every workspace, so
 * reading it means decoding each id and dropping the ones that belong
 * elsewhere. An id that fails to decode is skipped rather than failing the
 * enumeration: one malformed key must not make the whole catalog unreadable.
 *
 * Lives here rather than in `SessionRuntime` because the agent loop needs the
 * same enumeration and cannot import `SessionRuntime` — that module builds the
 * loops, so the dependency would be a cycle.
 */
export const listWorkspaceLoops = (input: {
  readonly workspaceId: WorkspaceId
  readonly entityIds: ReadonlyArray<string>
  readonly concurrency: number
}): Effect.Effect<ReadonlyArray<{ readonly sessionId: SessionId; readonly branchId: BranchId }>> =>
  Effect.forEach(input.entityIds, (entityId) => parseEntityId(entityId).pipe(Effect.option), {
    concurrency: input.concurrency,
  }).pipe(
    Effect.map((targets) =>
      targets.flatMap((target) => {
        if (Option.isNone(target) || target.value.workspaceId !== input.workspaceId) return []
        return [{ sessionId: target.value.sessionId, branchId: target.value.branchId }]
      }),
    ),
  )

// ── protocol ────────────────────────────────────────────────────────────────

/** Route a branch-scoped command to its loop entity, keyed by the command id. */
const branchTarget = (p: BranchCommandInput) => ({
  entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
  primaryKey: p.commandId,
})

/** Route a message-carrying command to its loop entity, keyed by the message id. */
const messageTarget = (p: TurnSubmissionInput | QueueFollowUpInput) => ({
  entityId: entityIdOf(p.workspaceId, p.message.sessionId, p.message.branchId),
  primaryKey: p.message.id,
})

/** Follow-up admission is idempotent by source: the message id is the durable key. */
export const followUpMessageIdForSource = (input: {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sourceId: string
}) =>
  MessageId.make(
    `follow-up:${input.workspaceId}:${input.sessionId}:${input.branchId}:${input.sourceId}`,
  )

/**
 * The interjection a steer lands, keyed by the steer's request id. A branch
 * the steer wakes opens its turn on this message, so a stop that names it
 * reaches that turn, or the steer while it still waits in the queue.
 */
export const interjectionMessageId = (requestId: RequestId | ActorCommandId) =>
  MessageId.make(`${requestId}:interjection`)

// Client payloads: what a caller outside the actor hands the loop. The
// runtime turns each into an actor operation below.

/**
 * The caller's id for a follow-up source. It is the last segment of the
 * follow-up message id (`followUpMessageIdForSource`), so a second queue of
 * the same source is a no-op and a dequeue names the item it takes back.
 * Bounded to 1–256 characters to bound the stored message id.
 */
const FollowUpSourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const SendUserMessagePayload = Schema.Struct({
  /**
   * `"admission"` returns once the turn is durably enqueued, without waiting
   * for it to run. Omitted, the call waits for the turn when the caller gave a
   * `requestId`/`commandId` to correlate on, and is fire-and-forget otherwise.
   */
  completion: Schema.optional(Schema.Literals(["admission"])),
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  /** Client-generated correlation id for end-to-end observability. */
  requestId: Schema.optional(RequestId),
  /** The envelope on the stored message; an extension's send names its author here. */
  metadata: Schema.optional(MessageMetadata),
})
export type SendUserMessagePayload = typeof SendUserMessagePayload.Type

const QueueFollowUpPayload = Schema.Struct({
  sourceId: FollowUpSourceIdSchema,
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  metadata: Schema.optional(MessageMetadata),
  /** Start a turn for the item even on a branch with no prior history. */
  wake: Schema.optional(Schema.Boolean),
  /** Admit the item only while this is the branch's newest step (`SessionSendParams`). */
  ifLatest: Schema.optional(MessageId),
})
type QueueFollowUpPayload = typeof QueueFollowUpPayload.Type

const DequeueFollowUpPayload = Schema.Struct({
  sourceId: FollowUpSourceIdSchema,
  sessionId: SessionId,
  branchId: BranchId,
})
type DequeueFollowUpPayload = typeof DequeueFollowUpPayload.Type

interface StopMessagePayload {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly messageId: MessageId
  readonly requestId: RequestId
  /**
   * The branch that asks for the stop. A turn remembers the requester of the
   * stop that first latched it, and the stop takes back the steers the same
   * branch sent into that turn.
   */
  readonly requester?: RequesterBranch
}

const WorkspaceFields = {
  workspaceId: WorkspaceId,
}

const TurnSubmissionFields = {
  ...WorkspaceFields,
  message: Message,
}

const QueueFollowUpFields = {
  ...WorkspaceFields,
  message: Message,
  /** Start a turn for this item even on a branch with no prior history. */
  wake: Schema.optional(Schema.Boolean),
  /**
   * Admit the item only while this is the branch's newest step, and start it
   * at once (`SessionSendParams`). Absent: the item is admitted whatever
   * the branch's newest step.
   */
  ifLatest: Schema.optional(MessageId),
}

/** `sender` is absent on a steer a client sent. */
const SteerFields = {
  ...WorkspaceFields,
  commandId: ActorCommandId,
  command: SteerCommand,
  /** The other branch that sent an `Interject`; a loop sets it, never a client. */
  sender: Schema.optional(RequesterBranch),
}

const RespondInteractionFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  requestId: InteractionRequestId,
}

/** One command addressed to a branch: drain, read, terminate. */
const BranchCommandFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  commandId: ActorCommandId,
}

/** One command about one message on a branch: remove its follow-up, stop what it opens. */
const MessageCommandFields = {
  ...BranchCommandFields,
  messageId: MessageId,
}

/** `requester` is absent on a stop a client asked for. */
const StopMessageFields = {
  ...MessageCommandFields,
  requester: Schema.optional(RequesterBranch),
}

export const ExtensionRequestInputEnvelope = Schema.TaggedUnion({
  Present: { value: Schema.Unknown },
  Missing: {},
})
type ExtensionRequestInputEnvelope = Schema.Schema.Type<typeof ExtensionRequestInputEnvelope>

const RequestExtensionFields = {
  ...BranchCommandFields,
  extensionId: ExtensionId,
  capabilityId: Schema.String,
  input: ExtensionRequestInputEnvelope,
}

/**
 * One wake record that came due, sent to its branch's loop. The record in
 * `branch_wakes` is the durable copy, so the message is not persisted;
 * `incarnation`, `version` and `attempts` make each fire its own message.
 */
const FireWakeFields = {
  ...WorkspaceFields,
  sessionId: SessionId,
  branchId: BranchId,
  extensionId: ExtensionId,
  sourceId: Schema.String,
  at: Schema.OptionFromOptionalKey(Schema.Finite),
  cause: WakeCause,
  incarnation: Schema.Int,
  version: Schema.Int,
  attempts: Schema.Int,
}

/**
 * What a fire did. `Handled`: the extension's `wakeDue` hook answered.
 * `Gone`: the session is terminated or the branch is gone. `Unhandled`: the
 * branch's profile has no such extension, or it has no `wakeDue` hook.
 */
export const WakeFired = Schema.TaggedUnion({
  Handled: { next: WakeNext },
  Gone: {},
  Unhandled: {},
})
export type WakeFired = typeof WakeFired.Type

type FieldsInput<F extends Schema.Struct.Fields> = Schema.Struct<F>["Type"]
export type TurnSubmissionInput = FieldsInput<typeof TurnSubmissionFields>
export type QueueFollowUpInput = FieldsInput<typeof QueueFollowUpFields>
export type SteerInput = FieldsInput<typeof SteerFields>
export type RespondInteractionInput = FieldsInput<typeof RespondInteractionFields>
export type BranchCommandInput = FieldsInput<typeof BranchCommandFields>
export type RemoveFollowUpInput = FieldsInput<typeof MessageCommandFields>
export type StopMessageInput = FieldsInput<typeof StopMessageFields>
export type RequestExtensionInput = FieldsInput<typeof RequestExtensionFields>
export type FireWakeInput = FieldsInput<typeof FireWakeFields>
export type HandlerRequest<Operation> = {
  readonly operation: Operation & { readonly _tag: string }
}

export const AgentLoop = Actor.fromEntity(
  "AgentLoop",
  {
    Submit: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AdmissionError,
      id: messageTarget,
    },
    SubmitAndWait: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AdmissionError,
      id: messageTarget,
    },
    SubmitDurable: {
      payload: TurnSubmissionFields,
      success: Schema.Void,
      error: AdmissionError,
      persisted: true,
      id: messageTarget,
    },
    QueueFollowUp: {
      payload: QueueFollowUpFields,
      success: Schema.Void,
      error: AdmissionError,
      id: messageTarget,
    },
    Steer: {
      payload: SteerFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: SteerInput) => ({
        entityId: entityIdOf(p.workspaceId, p.command.sessionId, p.command.branchId),
        primaryKey: p.commandId,
      }),
    },
    RespondInteraction: {
      payload: RespondInteractionFields,
      success: Schema.Void,
      error: AgentLoopError,
      persisted: true,
      id: (p: RespondInteractionInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: p.requestId,
      }),
    },
    // Queue drain is a mutating state transition; route it through the
    // branch-local actor so it serializes with the actor-owned queue.
    DrainQueue: {
      payload: BranchCommandFields,
      success: QueueSnapshot,
      error: AgentLoopError,
      persisted: true,
      id: branchTarget,
    },
    // Removing one queued follow-up mutates the queue too; same actor route.
    RemoveFollowUp: {
      payload: MessageCommandFields,
      success: Schema.Boolean,
      error: AgentLoopError,
      persisted: true,
      id: branchTarget,
    },
    // Stop what one message opens: take back its waiting steer, stop its
    // running turn, or cancel a turn that has not started. True when it did.
    StopMessage: {
      payload: StopMessageFields,
      success: Schema.Boolean,
      error: AgentLoopError,
      persisted: true,
      id: branchTarget,
    },
    GetQueue: {
      payload: BranchCommandFields,
      success: QueueSnapshot,
      error: AgentLoopError,
      id: branchTarget,
    },
    GetState: {
      payload: BranchCommandFields,
      success: SessionRuntimeStateSchema,
      error: AgentLoopError,
      id: branchTarget,
    },
    RequestExtension: {
      payload: RequestExtensionFields,
      success: RequestReply,
      error: AgentLoopError,
      id: branchTarget,
    },
    /**
     * Run one extension's `wakeDue` hook on the branch: the wake clock sends
     * it when a record comes due. The loop opens without resuming a turn a
     * restart cut short (deferred recovery), and the hook runs beside any turn.
     */
    FireWake: {
      payload: FireWakeFields,
      success: WakeFired,
      error: AgentLoopError,
      id: (p: FireWakeInput) => ({
        entityId: entityIdOf(p.workspaceId, p.sessionId, p.branchId),
        primaryKey: `wake:${p.extensionId}:${p.sourceId}:${p.incarnation}:${p.version}:${p.attempts}`,
      }),
    },
    /**
     * `TerminateBranch` shuts down a single branch's loop inside the entity's
     * own scope, so the branch's resources close there. The
     * `AgentLoopSessionGovernance`-driven `terminateSession` sweep sends it.
     */
    TerminateBranch: {
      payload: BranchCommandFields,
      success: Schema.Void,
      error: AgentLoopError,
      id: branchTarget,
    },
  },
  {
    state: {
      schema: SessionRuntimeStateSchema,
      error: AgentLoopError,
    },
  },
)

// ── client ──────────────────────────────────────────────────────────────────
//
// The verbs a caller outside a loop uses to reach any branch's loop: the
// session runtime for RPC callers, and the extension facade for a run that
// addresses another branch. Each resolves the target's actor ref by entity
// id; nothing here knows which loop is calling.

const userMessageIdForCommand = (commandId: ActorCommandId) => MessageId.make(commandId)
const commandIdForRequestId = (requestId: string) => ActorCommandId.make(`message:${requestId}`)
/** The user message a send under this request id opens, queued or running. */
export const userMessageIdForRequest = (requestId: string) =>
  userMessageIdForCommand(commandIdForRequestId(requestId))

const loopRefFor = Effect.fn("AgentLoop.client.refFor")(function* (
  sessionId: SessionId,
  branchId: BranchId,
) {
  const clientFor = yield* AgentLoop.Context
  const workspaceId = yield* CurrentWorkspaceId
  return yield* clientFor(entityIdOf(workspaceId, sessionId, branchId))
})

/**
 * One user message on a branch. `completion: "admission"` returns once the
 * loop holds the turn; a `commandId` or `requestId` waits for the turn to
 * end; neither is fire-and-forget.
 */
export const submitUserMessage = Effect.fn("AgentLoop.client.submitUserMessage")(function* (
  input: SendUserMessagePayload,
) {
  const platform = yield* GentPlatform
  let commandId: ActorCommandId
  if (Predicate.isNotUndefined(input.commandId)) {
    commandId = input.commandId
  } else if (Predicate.isNotUndefined(input.requestId)) {
    commandId = commandIdForRequestId(input.requestId)
  } else {
    commandId = ActorCommandId.make(yield* platform.randomId)
  }
  const shouldHoldCompletion =
    !Predicate.isUndefined(input.requestId) || !Predicate.isUndefined(input.commandId)
  const message = Message.cases.regular.make({
    id: userMessageIdForCommand(commandId),
    sessionId: input.sessionId,
    branchId: input.branchId,
    role: "user",
    parts: [Prompt.textPart({ text: input.content })],
    createdAt: yield* DateTime.nowAsDate,
    ...(Predicate.isNotUndefined(input.metadata) && { metadata: input.metadata }),
  })
  const payload = {
    workspaceId: yield* CurrentWorkspaceId,
    message,
  }
  const ref = yield* loopRefFor(input.sessionId, input.branchId)
  if (input.completion === "admission") {
    // A repeat of a durable submit is answered from its stored reply and
    // never reaches the loop. The state read opens the loop first, so a
    // repeat still resumes a turn the previous process left unfinished.
    yield* ref.execute(
      AgentLoop.GetState.make({
        workspaceId: payload.workspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId,
      }),
    )
    yield* ref.execute(AgentLoop.SubmitDurable.make(payload))
  } else if (shouldHoldCompletion) {
    yield* ref.execute(AgentLoop.SubmitAndWait.make(payload))
  } else {
    yield* ref.execute(AgentLoop.Submit.make(payload))
  }
  yield* Effect.logInfo("session-runtime.message.submitted").pipe(
    Effect.annotateLogs({ sessionId: input.sessionId, branchId: input.branchId }),
  )
})

/** Fire one wake record on its branch's loop. The record names its workspace. */
export const fireWakeOn = Effect.fn("AgentLoop.client.fireWake")(function* (input: FireWakeInput) {
  const clientFor = yield* AgentLoop.Context
  const ref = yield* clientFor(entityIdOf(input.workspaceId, input.sessionId, input.branchId))
  return yield* ref.execute(AgentLoop.FireWake.make(input))
})

/**
 * `ref.send` is fire-forget at the handler level — INTENTIONAL.
 * `Steer.Interject` semantics: the call returns once the actor holds
 * the command, before its handler parks the steering item, and long
 * before the interjected turn runs. A caller that must see the steer in
 * `queue.get` waits for it there. Switching to `ref.execute` (or `send + waitFor`) deadlocks
 * because `applySteer` itself yields `ensureStarted` while the gated
 * in-flight turn holds the actor; the persisted reply can't drain.
 * The session test "an interjection joins the running turn ahead of
 * queued follow-ups" times out under `ref.execute`. Note: `ref.send` does
 * NOT silently drop runtime delivery errors — the discardCall Effect
 * propagates; only statically typed `never`. `Steer.persisted: true`
 * is the durability guarantee (Steer survives crash + redeliver) and
 * is NOT what's being relaxed here.
 */
export const steerLoop = Effect.fn("AgentLoop.client.steer")(function* (
  command: SteerCommand,
  sender?: RequesterBranch,
) {
  const payload = {
    workspaceId: yield* CurrentWorkspaceId,
    commandId: ActorCommandId.make(command.requestId),
    command,
    sender,
  }
  const ref = yield* loopRefFor(command.sessionId, command.branchId)
  yield* ref.send(AgentLoop.Steer.make(payload))
})

/**
 * What the client verbs need beyond the per-request workspace: a holder
 * captures these once and provides them at each call.
 */
export type AgentLoopClientServices =
  | Context.Service.Identifier<typeof AgentLoop.Context>
  | GentPlatform

/** Queue a follow-up on a branch. Idempotent by source: the message id derives from it. */
export const queueFollowUpOn = Effect.fn("AgentLoop.client.queueFollowUp")(function* (
  input: QueueFollowUpPayload,
) {
  const workspaceId = yield* CurrentWorkspaceId
  const message = Message.cases.regular.make({
    id: followUpMessageIdForSource({ workspaceId, ...input }),
    sessionId: input.sessionId,
    branchId: input.branchId,
    role: "user",
    parts: [Prompt.textPart({ text: input.content })],
    createdAt: yield* DateTime.nowAsDate,
    metadata: input.metadata,
  })
  const ref = yield* loopRefFor(input.sessionId, input.branchId)
  yield* ref
    .execute(
      AgentLoop.QueueFollowUp.make({
        workspaceId,
        message,
        wake: input.wake,
        ifLatest: input.ifLatest,
      }),
    )
    .pipe(
      // A full queue stays the typed refusal; anything else is a loop fault.
      Effect.mapError((cause) => {
        if (Schema.is(FollowUpQueueFull)(cause)) return cause
        return new AgentLoopError({ message: `Failed to queue follow-up ${message.id}`, cause })
      }),
    )
})

/** Remove a queued follow-up on a branch by source. False when absent or already running. */
export const dequeueFollowUpOn = Effect.fn("AgentLoop.client.dequeueFollowUp")(function* (
  input: DequeueFollowUpPayload,
) {
  const workspaceId = yield* CurrentWorkspaceId
  const platform = yield* GentPlatform
  const ref = yield* loopRefFor(input.sessionId, input.branchId)
  return yield* ref
    .execute(
      AgentLoop.RemoveFollowUp.make({
        workspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: ActorCommandId.make(yield* platform.randomId),
        messageId: followUpMessageIdForSource({ workspaceId, ...input }),
      }),
    )
    .pipe(asAgentLoopError(`Failed to dequeue follow-up ${input.sourceId}`))
})

/** Stop what one message opens on a branch. True when the stop reached it. */
export const stopMessageOn = Effect.fn("AgentLoop.client.stopMessage")(function* (
  input: StopMessagePayload,
) {
  const workspaceId = yield* CurrentWorkspaceId
  const ref = yield* loopRefFor(input.sessionId, input.branchId)
  return yield* ref
    .execute(
      AgentLoop.StopMessage.make({
        workspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: ActorCommandId.make(input.requestId),
        messageId: input.messageId,
        requester: input.requester,
      }),
    )
    .pipe(asAgentLoopError(`Failed to stop message ${input.messageId}`))
})
