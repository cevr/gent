import { Clock, Context, Deferred, Effect, Layer, Ref, Schema, Stream, TxQueue } from "effect"

import { Message } from "./message"
import {
  ActorId,
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
import { makeSessionPubSubRegistry } from "./session-pubsub-registry"

// ============================================================================
// Shared sub-schemas
// ============================================================================

export const UsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
})
export type Usage = typeof UsageSchema.Type

export const QuestionOptionSchema = Schema.Struct({
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
  },
  StreamChunk: {
    sessionId: SessionId,
    branchId: BranchId,
    chunk: Schema.String,
  },
  StreamEnded: {
    sessionId: SessionId,
    branchId: BranchId,
    usage: Schema.optional(UsageSchema),
    // `model` identifies which model produced the stream that just ended.
    model: Schema.optional(ModelId),
    // `costUsd` is computed at emit-time from `usage` × pricing snapshot for
    // `model`. Freezing cost into the event makes the transcript authoritative:
    // replaying the same event log always sums to the same cost, even if the
    // upstream pricing registry later refreshes.
    costUsd: Schema.optional(Schema.Number),
    interrupted: Schema.optional(Schema.Boolean),
  },
  TurnCompleted: {
    sessionId: SessionId,
    branchId: BranchId,
    messageId: Schema.optional(MessageId),
    durationMs: Schema.Number,
    interrupted: Schema.optional(Schema.Boolean),
  },
  ToolCallStarted: {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    input: Schema.optional(Schema.Unknown),
  },
  ToolCallSucceeded: {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    summary: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
  },
  ToolCallFailed: {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    summary: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
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
  MachineTaskSucceeded: {
    sessionId: SessionId,
    branchId: BranchId,
    actorId: ActorId,
    stateTag: Schema.String,
  },
  MachineTaskFailed: {
    sessionId: SessionId,
    branchId: BranchId,
    actorId: ActorId,
    stateTag: Schema.String,
    error: Schema.String,
  },
  SessionNameUpdated: {
    sessionId: SessionId,
    name: Schema.String,
  },
  SessionSettingsUpdated: {
    sessionId: SessionId,
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
  BranchSummarized: {
    sessionId: SessionId,
    branchId: BranchId,
    summary: Schema.String,
  },
  AgentSwitched: {
    sessionId: SessionId,
    branchId: BranchId,
    fromAgent: AgentName,
    toAgent: AgentName,
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
        input: Schema.Number,
        output: Schema.Number,
        cost: Schema.optional(Schema.Number),
      }),
    ),
    preview: Schema.optional(Schema.String),
    savedPath: Schema.optional(Schema.String),
  },
  AgentRunFailed: {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: AgentName,
    toolCallId: Schema.optional(ToolCallId),
    branchId: Schema.optional(BranchId),
  },
  AgentRestarted: {
    sessionId: SessionId,
    branchId: BranchId,
    attempt: Schema.Number,
    error: Schema.optional(Schema.String),
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
export const MachineTaskSucceeded = AgentEvent.cases.MachineTaskSucceeded
export type MachineTaskSucceeded = typeof AgentEvent.cases.MachineTaskSucceeded.Type
export const MachineTaskFailed = AgentEvent.cases.MachineTaskFailed
export type MachineTaskFailed = typeof AgentEvent.cases.MachineTaskFailed.Type
export const SessionNameUpdated = AgentEvent.cases.SessionNameUpdated
export type SessionNameUpdated = typeof AgentEvent.cases.SessionNameUpdated.Type
export const SessionSettingsUpdated = AgentEvent.cases.SessionSettingsUpdated
export type SessionSettingsUpdated = typeof AgentEvent.cases.SessionSettingsUpdated.Type
export const BranchCreated = AgentEvent.cases.BranchCreated
export type BranchCreated = typeof AgentEvent.cases.BranchCreated.Type
export const BranchSwitched = AgentEvent.cases.BranchSwitched
export type BranchSwitched = typeof AgentEvent.cases.BranchSwitched.Type
export const BranchSummarized = AgentEvent.cases.BranchSummarized
export type BranchSummarized = typeof AgentEvent.cases.BranchSummarized.Type
export const AgentSwitched = AgentEvent.cases.AgentSwitched
export type AgentSwitched = typeof AgentEvent.cases.AgentSwitched.Type
export const AgentRunSpawned = AgentEvent.cases.AgentRunSpawned
export type AgentRunSpawned = typeof AgentEvent.cases.AgentRunSpawned.Type
export const AgentRunSucceeded = AgentEvent.cases.AgentRunSucceeded
export type AgentRunSucceeded = typeof AgentEvent.cases.AgentRunSucceeded.Type
export const AgentRunFailed = AgentEvent.cases.AgentRunFailed
export type AgentRunFailed = typeof AgentEvent.cases.AgentRunFailed.Type
export const AgentRestarted = AgentEvent.cases.AgentRestarted
export type AgentRestarted = typeof AgentEvent.cases.AgentRestarted.Type
export const ExtensionStateChanged = AgentEvent.cases.ExtensionStateChanged
export type ExtensionStateChanged = typeof AgentEvent.cases.ExtensionStateChanged.Type

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
}

// ============================================================================
// EventEnvelope + EventStore
// ============================================================================

export const EventId = Schema.Number.pipe(branded("EventId"))
export type EventId = typeof EventId.Type

export class EventEnvelope extends Schema.Class<EventEnvelope>("EventEnvelope")({
  id: EventId,
  event: AgentEvent,
  createdAt: Schema.Number,
  traceId: Schema.optional(Schema.String),
}) {}

export class EventStoreError extends Schema.TaggedErrorClass<EventStoreError>()("EventStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface EventStoreService {
  readonly append: (event: AgentEvent) => Effect.Effect<EventEnvelope, EventStoreError>
  readonly broadcast: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly deliver: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
  readonly subscribe: (params: {
    sessionId: SessionId
    branchId?: BranchId
    after?: EventId
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
              if (oldest !== undefined) delivered.delete(oldest)
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

const matchEventSessionId = AgentEvent.match({
  SessionStarted: (e) => e.sessionId,
  MessageReceived: (e) => e.message.sessionId,
  StreamStarted: (e) => e.sessionId,
  StreamChunk: (e) => e.sessionId,
  StreamEnded: (e) => e.sessionId,
  TurnCompleted: (e) => e.sessionId,
  ToolCallStarted: (e) => e.sessionId,
  ToolCallSucceeded: (e) => e.sessionId,
  ToolCallFailed: (e) => e.sessionId,
  InteractionPresented: (e) => e.sessionId,
  InteractionResolved: (e) => e.sessionId,
  ErrorOccurred: (e) => e.sessionId,
  ProviderRetrying: (e) => e.sessionId,
  MachineTaskSucceeded: (e) => e.sessionId,
  MachineTaskFailed: (e) => e.sessionId,
  SessionNameUpdated: (e) => e.sessionId,
  SessionSettingsUpdated: (e) => e.sessionId,
  BranchCreated: (e) => e.sessionId,
  BranchSwitched: (e) => e.sessionId,
  BranchSummarized: (e) => e.sessionId,
  AgentSwitched: (e) => e.sessionId,
  AgentRunSpawned: (e) => e.parentSessionId,
  AgentRunSucceeded: (e) => e.parentSessionId,
  AgentRunFailed: (e) => e.parentSessionId,
  AgentRestarted: (e) => e.sessionId,
  ExtensionStateChanged: (e) => e.sessionId,
})

export const getEventSessionId = (event: AgentEvent): SessionId | undefined =>
  matchEventSessionId(event)

const matchEventBranchId = AgentEvent.match({
  SessionStarted: (e) => e.branchId,
  MessageReceived: (e) => e.message.branchId,
  StreamStarted: (e) => e.branchId,
  StreamChunk: (e) => e.branchId,
  StreamEnded: (e) => e.branchId,
  TurnCompleted: (e) => e.branchId,
  ToolCallStarted: (e) => e.branchId,
  ToolCallSucceeded: (e) => e.branchId,
  ToolCallFailed: (e) => e.branchId,
  InteractionPresented: (e) => e.branchId,
  InteractionResolved: (e) => e.branchId,
  ErrorOccurred: (e) => e.branchId,
  ProviderRetrying: (e) => e.branchId,
  MachineTaskSucceeded: (e) => e.branchId,
  MachineTaskFailed: (e) => e.branchId,
  SessionNameUpdated: () => undefined,
  SessionSettingsUpdated: () => undefined,
  BranchCreated: (e) => e.branchId,
  // BranchSwitched has no `branchId` field — `from`/`to` are both per-branch.
  // Returning `undefined` lets branch-scoped subscribers see the switch on
  // either side, matching the prior structural-narrowing behavior.
  BranchSwitched: () => undefined,
  BranchSummarized: (e) => e.branchId,
  AgentSwitched: (e) => e.branchId,
  AgentRunSpawned: (e) => e.branchId,
  AgentRunSucceeded: (e) => e.branchId,
  AgentRunFailed: (e) => e.branchId,
  AgentRestarted: (e) => e.branchId,
  ExtensionStateChanged: (e) => e.branchId,
})

export const getEventBranchId = (event: AgentEvent): BranchId | undefined =>
  matchEventBranchId(event)

export const matchesEventFilter = (
  env: EventEnvelope,
  sessionId: SessionId,
  branchId?: BranchId,
): boolean => {
  const eventSessionId = getEventSessionId(env.event)
  if (eventSessionId === undefined || eventSessionId !== sessionId) return false
  return matchesBranchFilter(env, branchId)
}

/** Branch-only filter — use when session is already known to match. */
export const matchesBranchFilter = (env: EventEnvelope, branchId?: BranchId): boolean => {
  if (branchId === undefined) return true
  const eventBranchId = getEventBranchId(env.event)
  return eventBranchId === branchId || eventBranchId === undefined
}

// EventStore Service

const makeMemoryEventStore = Effect.gen(function* () {
  const registry = yield* makeSessionPubSubRegistry
  const eventsRef = yield* Ref.make<EventEnvelope[]>([])
  const idRef = yield* Ref.make(0)

  const deliver = yield* makeSerializedEventDelivery(registry.broadcast)

  const service: EventStoreService = {
    append: Effect.fn("EventStore.append")(function* (event) {
      const id = yield* Ref.modify(idRef, (n) => [n + 1, n + 1])
      const currentSpan = yield* Effect.currentParentSpan.pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const envelope = EventEnvelope.make({
        id: EventId.make(id),
        event,
        createdAt: yield* Clock.currentTimeMillis,
        ...(currentSpan !== undefined ? { traceId: currentSpan.traceId } : {}),
      })
      yield* Ref.update(eventsRef, (events) => [...events, envelope])
      return envelope
    }),

    broadcast: registry.broadcast,
    deliver,

    publish: Effect.fn("EventStore.publish")(function* (event) {
      const envelope = yield* service.append(event)
      yield* deliver(envelope)
    }),

    subscribe: ({ sessionId, branchId, after }) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const afterId = after ?? EventId.make(0)
            const subscription = yield* registry.subscribe(sessionId)
            const latestId = yield* Ref.get(idRef)
            const buffered = (yield* Ref.get(eventsRef)).filter(
              (env) =>
                env.id > afterId &&
                env.id <= latestId &&
                matchesEventFilter(env, sessionId, branchId),
            )
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.filter((env) => env.id > latestId && matchesBranchFilter(env, branchId)),
            )
            return Stream.concat(Stream.fromIterable(buffered), live)
          }),
        ),
      ),

    removeSession: registry.remove,
  }
  return service
})

export class EventStore extends Context.Service<EventStore, EventStoreService>()(
  "@gent/core/src/domain/event/EventStore",
) {
  static Memory: Layer.Layer<EventStore> = Layer.unwrap(
    makeMemoryEventStore.pipe(Effect.map((service) => Layer.succeed(EventStore, service))),
  )
}
