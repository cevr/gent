import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
  TxQueue,
} from "effect"
import type { Scope } from "effect"

import { Message } from "./message"
import {
  branded,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "./ids"
import { AgentName, ReasoningEffort } from "./agent"
import { ModelId } from "./model"
import { makeCursorReplayStream, makeSessionPubSubRegistry } from "./session-pubsub-registry"
import { clipChars } from "./head-tail"

// ============================================================================
// Shared sub-schemas
// ============================================================================

export const UsageSchema = Schema.Struct({
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  cacheReadTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  cacheWriteTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type Usage = typeof UsageSchema.Type

const QuestionOptionSchema = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export type QuestionOption = typeof QuestionOptionSchema.Type

export const QuestionSchema = Schema.Struct({
  question: Schema.String,
  header: Schema.optional(Schema.String),
  markdown: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(QuestionOptionSchema)),
  multiple: Schema.optional(Schema.Boolean),
})
export type Question = typeof QuestionSchema.Type

// ============================================================================
// AgentEvent — the discriminated union of every event the runtime emits.
//
// Authored via upstream `Schema.TaggedUnion({...})` shorthand. Variant names
// are also the wire `_tag` values, so the shorthand covers the full surface
// (decode/encode, `cases.X.make`, `match`, `guards`, `isAnyOf`) without a
// bespoke factory. Construction reads `AgentEvent.cases.SessionStarted.make`
// or — via the per-variant re-exports below — `SessionStarted.make`. Pattern
// matching uses `AgentEvent.match({...})`; `_tag === "X"` narrowing works
// unchanged. Wire shape: `{ _tag: "VariantName", ...fields }`.
// ============================================================================

export const EventId = Schema.Finite.pipe(branded("EventId"))
export type EventId = typeof EventId.Type

/** Tags of `StepOutcome` in `agent-loop.turn-execution.ts`, as they travel on `StreamEnded`. */
const StepOutcomeTag = Schema.Literals([
  "Interrupted",
  "Failed",
  "External",
  "ToolCalls",
  "Answered",
])

export const AgentEvent = Schema.TaggedUnion({
  SessionStarted: {
    sessionId: SessionId,
    branchId: BranchId,
  },
  MessageReceived: {
    message: Message,
  },
  StreamStarted: {
    sessionId: SessionId,
    branchId: BranchId,
    messageId: Schema.optional(MessageId),
    step: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  },
  StreamChunk: {
    sessionId: SessionId,
    branchId: BranchId,
    chunk: Schema.String,
  },
  StreamEnded: {
    sessionId: SessionId,
    branchId: BranchId,
    messageId: Schema.optional(MessageId),
    step: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    usage: Schema.optional(UsageSchema),
    // `model` identifies which model produced the stream that just ended.
    model: Schema.optional(ModelId),
    // `costUsd` is computed at emit-time from `usage` × pricing snapshot for
    // `model`. Freezing cost into the event makes the transcript authoritative:
    // replaying the same event log always sums to the same cost, even if the
    // upstream pricing registry later refreshes.
    costUsd: Schema.optional(Schema.Finite),
    interrupted: Schema.optional(Schema.Boolean),
    /** How the step ended; the step boundary the loop's policy matched on. */
    outcome: Schema.optional(StepOutcomeTag),
  },
  TurnCompleted: {
    sessionId: SessionId,
    branchId: BranchId,
    messageId: Schema.optional(MessageId),
    durationMs: Schema.Finite,
    interrupted: Schema.optional(Schema.Boolean),
    // Absent in historical receipts; absence does not prove model success.
    streamFailed: Schema.optional(Schema.Boolean),
    /**
     * True when the turn ended without the model ever producing an answer —
     * every continuation was spent and the last step still yielded nothing.
     * Distinguishes "gave up" from "replied": without it a caller sees a
     * successful turn and an empty transcript, and cannot tell them apart.
     * Absent on historical receipts and on every turn that did reply.
     */
    unanswered: Schema.optional(Schema.Boolean),
    /**
     * Token totals over every model step of this turn. Absent when any step
     * reported no usage or an unusable count, and on historical receipts.
     */
    usage: Schema.optional(UsageSchema),
  },
  /** What the model saw this turn after projection and compaction. */
  ModelContextProjected: {
    sessionId: SessionId,
    branchId: BranchId,
    estimatedTokens: Schema.Natural,
    availableInputTokens: Schema.Natural,
    contextLimitTokens: Schema.Natural,
    omittedMessages: Schema.Natural,
    /** The handoff marker leading this window, when it carries a summary. */
    handoffMessageId: Schema.optional(MessageId),
    /** This projection wrote a handoff. */
    compacted: Schema.Boolean,
  },
  ToolCallStarted: {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    input: Schema.optional(Schema.Unknown),
    /** Set when a cell admitted this call. Absent for direct model calls. */
    parentToolCallId: Schema.optional(ToolCallId),
    /** The assistant message that holds the tool-call part. Absent in historical receipts. */
    assistantMessageId: Schema.optional(MessageId),
  },
  ToolCallSucceeded: {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    summary: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
    resultJson: Schema.optional(Schema.String),
    parentToolCallId: Schema.optional(ToolCallId),
    assistantMessageId: Schema.optional(MessageId),
  },
  ToolCallFailed: {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    summary: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
    resultJson: Schema.optional(Schema.String),
    parentToolCallId: Schema.optional(ToolCallId),
    assistantMessageId: Schema.optional(MessageId),
  },
  /** Generic interaction event — replaces PromptPresented, HandoffPresented, QuestionsAsked */
  InteractionPresented: {
    sessionId: SessionId,
    branchId: BranchId,
    requestId: InteractionRequestId,
    text: Schema.String,
    metadata: Schema.optional(Schema.Unknown),
  },
  /** Generic interaction resolution — replaces all Confirmed/Rejected/Dismissed events */
  InteractionResolved: {
    sessionId: SessionId,
    branchId: BranchId,
    requestId: InteractionRequestId,
    approved: Schema.Boolean,
    notes: Schema.optional(Schema.String),
    editedContent: Schema.optional(Schema.String),
  },
  ErrorOccurred: {
    sessionId: SessionId,
    branchId: Schema.optional(BranchId),
    error: Schema.String,
  },
  ProviderRetrying: {
    sessionId: SessionId,
    branchId: BranchId,
    attempt: Schema.Int,
    maxAttempts: Schema.Int,
    delayMs: Schema.Int,
    error: Schema.String,
  },
  SessionNameUpdated: {
    sessionId: SessionId,
    name: Schema.String,
  },
  /** The session's full settings after a change; absent fields are unset. */
  SessionSettingsUpdated: {
    sessionId: SessionId,
    modelId: Schema.optional(ModelId),
    reasoningLevel: Schema.optional(ReasoningEffort),
  },
  BranchCreated: {
    sessionId: SessionId,
    branchId: BranchId,
    parentBranchId: Schema.optional(BranchId),
    parentMessageId: Schema.optional(MessageId),
  },
  BranchSwitched: {
    sessionId: SessionId,
    fromBranchId: BranchId,
    toBranchId: BranchId,
  },
  AgentRunSpawned: {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: AgentName,
    prompt: Schema.String,
    toolCallId: Schema.optional(ToolCallId),
    branchId: Schema.optional(BranchId),
    childBranchId: Schema.optional(BranchId),
  },
  AgentRunSucceeded: {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: AgentName,
    toolCallId: Schema.optional(ToolCallId),
    branchId: Schema.optional(BranchId),
    usage: Schema.optional(
      Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        cost: Schema.optional(Schema.Finite),
      }),
    ),
    preview: Schema.optional(Schema.String),
  },
  AgentRunFailed: {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: AgentName,
    toolCallId: Schema.optional(ToolCallId),
    branchId: Schema.optional(BranchId),
  },
  /**
   * Typed state-change notification emitted when an extension's
   * externally-observable state may have changed. Carries no payload —
   * clients fetch via the extension's typed request capability (the
   * published transport surface).
   *
   * Replaces `ExtensionUiSnapshot`'s privileged out-of-band channel. The event
   * is honest: it tells subscribers "extension X has news" without coupling a
   * schema between server and client. Any transport consumer (TUI, SDK, future
   * web UI) reads the new state the same way — via `client.extension.request`.
   *
   * Client widgets subscribe by `extensionId` filter and refetch their typed
   * capability request on each pulse.
   */
  ExtensionStateChanged: {
    sessionId: SessionId,
    branchId: BranchId,
    extensionId: ExtensionId,
  },
  /**
   * Synchronization marker. A subscription opened with `synchronize` emits it
   * once, after the durable replay and before the first live event. Its
   * envelope id equals the replay cursor, so a client that stores the last
   * seen id keeps an exact resume point. It is never stored: `append` rejects it.
   */
  StreamSynchronized: {
    sessionId: SessionId,
    branchId: Schema.optional(BranchId),
    lastEventId: EventId,
  },
})
export type AgentEvent = Schema.Schema.Type<typeof AgentEvent>

// ============================================================================
// Per-variant re-exports — same TaggedStruct identity as `AgentEvent.cases.X`,
// exposed at module scope so consumers may import variants directly without
// going through the union object. `SessionStarted.make(...)` and
// `AgentEvent.cases.SessionStarted.make(...)` produce structurally identical
// values; these are aliases, not parallel implementations.
// ============================================================================

export const SessionStarted = AgentEvent.cases.SessionStarted
export type SessionStarted = typeof AgentEvent.cases.SessionStarted.Type
export const MessageReceived = AgentEvent.cases.MessageReceived
export type MessageReceived = typeof AgentEvent.cases.MessageReceived.Type
export const StreamStarted = AgentEvent.cases.StreamStarted
export type StreamStarted = typeof AgentEvent.cases.StreamStarted.Type
export const StreamChunk = AgentEvent.cases.StreamChunk
export type StreamChunk = typeof AgentEvent.cases.StreamChunk.Type
export const StreamEnded = AgentEvent.cases.StreamEnded
export type StreamEnded = typeof AgentEvent.cases.StreamEnded.Type
export const TurnCompleted = AgentEvent.cases.TurnCompleted
export type TurnCompleted = typeof AgentEvent.cases.TurnCompleted.Type
export const ModelContextProjected = AgentEvent.cases.ModelContextProjected
export type ModelContextProjected = typeof AgentEvent.cases.ModelContextProjected.Type
export const ToolCallStarted = AgentEvent.cases.ToolCallStarted
export type ToolCallStarted = typeof AgentEvent.cases.ToolCallStarted.Type
export const ToolCallSucceeded = AgentEvent.cases.ToolCallSucceeded
export type ToolCallSucceeded = typeof AgentEvent.cases.ToolCallSucceeded.Type
export const ToolCallFailed = AgentEvent.cases.ToolCallFailed
export type ToolCallFailed = typeof AgentEvent.cases.ToolCallFailed.Type
export const InteractionPresented = AgentEvent.cases.InteractionPresented
export type InteractionPresented = typeof AgentEvent.cases.InteractionPresented.Type
export const InteractionResolved = AgentEvent.cases.InteractionResolved
export type InteractionResolved = typeof AgentEvent.cases.InteractionResolved.Type
export const ErrorOccurred = AgentEvent.cases.ErrorOccurred
export type ErrorOccurred = typeof AgentEvent.cases.ErrorOccurred.Type
export const ProviderRetrying = AgentEvent.cases.ProviderRetrying
export type ProviderRetrying = typeof AgentEvent.cases.ProviderRetrying.Type
export const SessionNameUpdated = AgentEvent.cases.SessionNameUpdated
export type SessionNameUpdated = typeof AgentEvent.cases.SessionNameUpdated.Type
export const SessionSettingsUpdated = AgentEvent.cases.SessionSettingsUpdated
export type SessionSettingsUpdated = typeof AgentEvent.cases.SessionSettingsUpdated.Type
export const BranchCreated = AgentEvent.cases.BranchCreated
export type BranchCreated = typeof AgentEvent.cases.BranchCreated.Type
export const BranchSwitched = AgentEvent.cases.BranchSwitched
export type BranchSwitched = typeof AgentEvent.cases.BranchSwitched.Type
export const AgentRunSpawned = AgentEvent.cases.AgentRunSpawned
export type AgentRunSpawned = typeof AgentEvent.cases.AgentRunSpawned.Type
export const AgentRunSucceeded = AgentEvent.cases.AgentRunSucceeded
export type AgentRunSucceeded = typeof AgentEvent.cases.AgentRunSucceeded.Type
/** Bounded child reply carried on `AgentRunSucceeded.preview`. Every producer clips through here. */
const agentRunPreviewChars = 200
const clipPreview = (text: string): string => clipChars(text, agentRunPreviewChars)
/**
 * The one receipt a finished child run publishes. Both producers — the
 * in-process runner and child-completion delivery — build it here, so the
 * preview clip and the usage shape cannot drift apart.
 */
export const childRunSucceeded = (params: {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly agentName: AgentName
  readonly toolCallId?: ToolCallId
  readonly branchId?: BranchId
  readonly usage?: { readonly input: number; readonly output: number; readonly cost?: number }
  readonly text: string
}) => {
  const fields = {
    parentSessionId: params.parentSessionId,
    childSessionId: params.childSessionId,
    agentName: params.agentName,
    preview: clipPreview(params.text),
  }
  if (Predicate.isNotUndefined(params.toolCallId)) {
    Object.assign(fields, { toolCallId: params.toolCallId })
  }
  if (Predicate.isNotUndefined(params.branchId))
    Object.assign(fields, { branchId: params.branchId })
  if (Predicate.isNotUndefined(params.usage)) Object.assign(fields, { usage: params.usage })
  return AgentRunSucceeded.make(fields)
}
export const AgentRunFailed = AgentEvent.cases.AgentRunFailed
export type AgentRunFailed = typeof AgentEvent.cases.AgentRunFailed.Type
export const ExtensionStateChanged = AgentEvent.cases.ExtensionStateChanged
export type ExtensionStateChanged = typeof AgentEvent.cases.ExtensionStateChanged.Type
export const StreamSynchronized = AgentEvent.cases.StreamSynchronized
export type StreamSynchronized = typeof AgentEvent.cases.StreamSynchronized.Type

/** Union of all `_tag` literal strings across `AgentEvent` variants. */
export type AgentEventTag = Schema.Schema.Type<typeof AgentEvent>["_tag"]

// ============================================================================
// Interaction types — shared between server and client
// ============================================================================

/** Active interaction — the generic InteractionPresented event */
export type ActiveInteraction = InteractionPresented

/** Approval decision — the generic resolution */
export type ApprovalResult = {
  readonly approved: boolean
  readonly notes?: string
  readonly editedContent?: string
}

// ============================================================================
// EventEnvelope + EventStore
// ============================================================================

export class EventEnvelope extends Schema.Class<EventEnvelope>("EventEnvelope")({
  id: EventId,
  event: AgentEvent,
  createdAt: Schema.Finite,
  traceId: Schema.optional(Schema.String),
}) {}

export class EventStoreError extends Schema.TaggedError<EventStoreError>()("EventStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EventStoreService {
  readonly append: (event: AgentEvent) => Effect.Effect<EventEnvelope, EventStoreError>
  readonly deliver: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
  readonly subscribe: (params: {
    sessionId: SessionId
    branchId?: BranchId
    after?: EventId
    /** Emit one `StreamSynchronized` marker between the durable replay and live delivery. */
    synchronize?: boolean
  }) => Stream.Stream<EventEnvelope, EventStoreError>
  /** Remove session PubSub, shutting down any active subscribers. */
  readonly removeSession: (sessionId: SessionId) => Effect.Effect<void>
}

type EventDeliveryJob = {
  readonly envelope: EventEnvelope
  readonly ack: Deferred.Deferred<void>
}

export const makeSerializedEventDelivery = (
  broadcast: (envelope: EventEnvelope) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const queue = yield* TxQueue.unbounded<EventDeliveryJob>()
    const delivered = new Set<EventEnvelope["id"]>()
    const maxDeliveredIds = 1024
    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((job) =>
        Effect.gen(function* () {
          if (delivered.has(job.envelope.id)) {
            yield* Deferred.succeed(job.ack, void 0)
            return
          }
          const exit = yield* Effect.exit(broadcast(job.envelope))
          if (exit._tag === "Success") {
            delivered.add(job.envelope.id)
            if (delivered.size > maxDeliveredIds) {
              const oldest = delivered.values().next().value
              if (!Predicate.isUndefined(oldest)) delivered.delete(oldest)
            }
          }
          yield* Deferred.done(job.ack, exit)
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    )

    return (envelope: EventEnvelope) =>
      Effect.gen(function* () {
        const ack = yield* Deferred.make<void>()
        yield* TxQueue.offer(queue, { envelope, ack })
        yield* Deferred.await(ack)
      })
  })

// Every variant names its session as `sessionId`, except the message
// envelope and the child-run receipts, which name the parent.
export const getEventSessionId = (event: AgentEvent): SessionId => {
  if (event._tag === "MessageReceived") return event.message.sessionId
  if ("parentSessionId" in event) return event.parentSessionId
  return event.sessionId
}

// Session-level events and `BranchSwitched` (whose `from`/`to` are both
// per-branch) carry no single branch identity, so branch-scoped
// subscribers see them on every branch.
// oxlint-disable-next-line effect/noNullish -- Some event variants intentionally have no branch identity.
export const getEventBranchId = (event: AgentEvent): BranchId | undefined => {
  if (event._tag === "MessageReceived") return event.message.branchId
  if ("branchId" in event) return event.branchId
  // oxlint-disable-next-line effect/noNullish -- Some event variants intentionally have no branch identity.
  return undefined
}

export const matchesEventFilter = (
  env: EventEnvelope,
  sessionId: SessionId,
  branchId?: BranchId,
): boolean => {
  const eventSessionId = getEventSessionId(env.event)
  if (Predicate.isUndefined(eventSessionId) || eventSessionId !== sessionId) return false
  return matchesBranchFilter(env, branchId)
}

/** Branch-only filter — use when session is already known to match. */
export const matchesBranchFilter = (env: EventEnvelope, branchId?: BranchId): boolean => {
  if (Predicate.isUndefined(branchId)) return true
  const eventBranchId = getEventBranchId(env.event)
  return eventBranchId === branchId || Predicate.isUndefined(eventBranchId)
}

// EventStore Service

/** The marker describes one subscription's position. Storing it would replay a lie. */
const rejectStreamMarker = (event: AgentEvent) =>
  Effect.gen(function* () {
    if (event._tag === "StreamSynchronized") {
      return yield* new EventStoreError({
        message: "StreamSynchronized is a subscription marker and is never stored",
      })
    }
  })

/** The durable half of an event store; `makeEventStore` supplies delivery, replay, and subscriptions. */
interface EventStoreBackend {
  readonly append: (
    event: AgentEvent,
    traceId: Option.Option<string>,
  ) => Effect.Effect<EventEnvelope, EventStoreError>
  readonly load: (
    sessionId: SessionId,
    afterId: EventId,
  ) => Effect.Effect<ReadonlyArray<EventEnvelope>, EventStoreError>
  /** Runs inside the subscription scope before replay starts. */
  readonly open?: (
    params: Parameters<EventStoreService["subscribe"]>[0],
  ) => Effect.Effect<void, EventStoreError, Scope.Scope>
}

export const makeEventStore = Effect.fn("makeEventStore")(function* (backend: EventStoreBackend) {
  const registry = yield* makeSessionPubSubRegistry
  const deliver = yield* makeSerializedEventDelivery(registry.broadcast)

  const service: EventStoreService = {
    append: Effect.fn("EventStore.append")(function* (event) {
      yield* rejectStreamMarker(event)
      const currentSpan = yield* Effect.currentParentSpan.pipe(Effect.option)
      return yield* backend.append(
        event,
        Option.map(currentSpan, (span) => span.traceId),
      )
    }),

    deliver,

    publish: Effect.fn("EventStore.publish")(function* (event) {
      const envelope = yield* service.append(event)
      yield* deliver(envelope)
    }),

    subscribe: (params) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const { sessionId, branchId, after, synchronize } = params
            if (backend.open) yield* backend.open(params)
            const subscription = yield* registry.subscribe(sessionId)
            return makeCursorReplayStream({
              subscription,
              sessionId,
              afterId: after ?? EventId.make(0),
              branchId,
              synchronize,
              load: (afterId) => backend.load(sessionId, afterId),
            })
          }),
        ),
      ),

    removeSession: registry.remove,
  }
  return service
})

const makeMemoryEventStore = Effect.gen(function* () {
  const eventsRef = yield* Ref.make<EventEnvelope[]>([])
  const idRef = yield* Ref.make(0)
  return yield* makeEventStore({
    append: (event, traceId) =>
      Effect.gen(function* () {
        const id = yield* Ref.modify(idRef, (n) => [n + 1, n + 1])
        const fields = {
          id: EventId.make(id),
          event,
          createdAt: yield* Clock.currentTimeMillis,
        }
        if (Option.isSome(traceId)) Object.assign(fields, { traceId: traceId.value })
        const envelope = EventEnvelope.make(fields)
        yield* Ref.update(eventsRef, (events) => [...events, envelope])
        return envelope
      }),
    load: (sessionId, afterId) =>
      Ref.get(eventsRef).pipe(
        Effect.map((events) =>
          events.filter((env) => env.id > afterId && matchesEventFilter(env, sessionId)),
        ),
      ),
  })
})

export class EventStore extends Context.Service<EventStore, EventStoreService>()(
  "@gent/core/src/domain/event/EventStore",
) {
  static Memory: Layer.Layer<EventStore> = Layer.unwrap(
    makeMemoryEventStore.pipe(Effect.map((service) => Layer.succeed(EventStore, service))),
  )
}
