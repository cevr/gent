import { Clock, Context, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"

import { Message } from "./message"
import { branded, BranchId, MessageId, SessionId, TaskId, ToolCallId } from "./ids"
import { AgentName, ReasoningEffort } from "./agent"
import { ModelId } from "./model"
import { TaggedEnumClass } from "./schema-tagged-enum-class"

// ============================================================================
// Shared sub-schemas
// ============================================================================

export const UsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
})
export type Usage = typeof UsageSchema.Type

export const RecoveryPhase = Schema.Literals(["Idle", "Running", "WaitingForInteraction"])
export type RecoveryPhase = typeof RecoveryPhase.Type

export const RecoveryAction = Schema.Literals([
  "resume-queued-turn",
  "replay-running",
  "restore-cold",
])
export type RecoveryAction = typeof RecoveryAction.Type

export const MachineInspectionType = Schema.Literals([
  "@machine.spawn",
  "@machine.event",
  "@machine.transition",
  "@machine.effect",
  "@machine.task",
  "@machine.error",
  "@machine.stop",
])
export type MachineInspectionType = typeof MachineInspectionType.Type

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
// Authored via `TaggedEnumClass` (see `./schema-tagged-enum-class.ts`) — one
// call replaces 34 hand-written `Schema.TaggedClass` declarations + a
// hand-assembled `Schema.Union(...)`. Per-variant classes are exposed as own
// properties (`AgentEvent.SessionStarted`) so construction reads
// `SessionStarted.make({...})`. Pattern-match via `Match.tag` or
// `_tag === "X"` works unchanged — the wire shape is identical.
// ============================================================================

export const AgentEvent = TaggedEnumClass("AgentEvent", {
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
  TurnRecoveryApplied: {
    sessionId: SessionId,
    branchId: BranchId,
    phase: RecoveryPhase,
    action: RecoveryAction,
    detail: Schema.optional(Schema.String),
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
    requestId: Schema.String,
    text: Schema.String,
    metadata: Schema.optional(Schema.Unknown),
  },
  /** Generic interaction resolution — replaces all Confirmed/Rejected/Dismissed events */
  InteractionResolved: {
    sessionId: SessionId,
    branchId: BranchId,
    requestId: Schema.String,
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
  /**
   * Machine inspection events are published to the EventStore on purpose.
   *
   * Why:
   * - They let the TUI/debug surfaces observe real actor transitions without bespoke debug channels.
   * - They give us post-hoc receipts for queue/turn/task bugs that normal message history loses.
   * - They bridge machine internals into the same session-scoped event stream the rest of Gent already uses.
   *
   * They are observability events, not business events. Consumers should treat them as optional diagnostics.
   */
  MachineInspected: {
    sessionId: SessionId,
    branchId: BranchId,
    actorId: Schema.String,
    inspectionType: MachineInspectionType,
    payload: Schema.Unknown,
  },
  MachineTaskSucceeded: {
    sessionId: SessionId,
    branchId: BranchId,
    actorId: Schema.String,
    stateTag: Schema.String,
  },
  MachineTaskFailed: {
    sessionId: SessionId,
    branchId: BranchId,
    actorId: Schema.String,
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
  TaskCreated: {
    sessionId: SessionId,
    branchId: BranchId,
    taskId: TaskId,
    subject: Schema.String,
  },
  TaskUpdated: {
    sessionId: SessionId,
    branchId: BranchId,
    taskId: TaskId,
    status: Schema.String,
  },
  TaskCompleted: {
    sessionId: SessionId,
    branchId: BranchId,
    taskId: TaskId,
    owner: Schema.optional(SessionId),
  },
  TaskFailed: {
    sessionId: SessionId,
    branchId: BranchId,
    taskId: TaskId,
    error: Schema.optional(Schema.String),
  },
  TaskStopped: {
    sessionId: SessionId,
    branchId: BranchId,
    taskId: TaskId,
  },
  TaskDeleted: {
    sessionId: SessionId,
    branchId: BranchId,
    taskId: TaskId,
  },
  AgentRestarted: {
    sessionId: SessionId,
    branchId: BranchId,
    attempt: Schema.Number,
    error: Schema.optional(Schema.String),
  },
  /**
   * Typed pulse emitted whenever an extension's externally-observable state
   * may have changed. Carries no payload — clients fetch via the extension's
   * typed request capability (the published transport surface).
   *
   * Replaces `ExtensionUiSnapshot`'s privileged out-of-band channel. The pulse
   * is honest: it tells subscribers "extension X has news" without coupling a
   * schema between server and client. Any transport consumer (TUI, SDK, future
   * web UI) reads the new state the same way — via `client.extension.request`.
   *
   * Server publishes this after:
   *   - A workflow state machine transition (machine.afterTransition)
   *   - A projection's underlying source emits an event the projection observes
   *
   * Client widgets subscribe by `extensionId` filter and refetch their typed
   * capability request on each pulse.
   */
  ExtensionStateChanged: {
    sessionId: SessionId,
    branchId: BranchId,
    extensionId: Schema.String,
  },
})
export type AgentEvent = Schema.Schema.Type<typeof AgentEvent>

// ============================================================================
// Per-variant re-exports — same class identity as `AgentEvent.X`, exposed at
// module scope so consumers may import variants directly without going
// through the enum object. `SessionStarted.make(...)` and
// `AgentEvent.SessionStarted.make(...)` produce instances of the SAME class;
// these are aliases, not parallel implementations. Use whichever reads better
// at the call site — both communicate "variant of AgentEvent."
// ============================================================================

export const SessionStarted = AgentEvent.SessionStarted
export type SessionStarted = typeof AgentEvent.SessionStarted.Type
export const MessageReceived = AgentEvent.MessageReceived
export type MessageReceived = typeof AgentEvent.MessageReceived.Type
export const StreamStarted = AgentEvent.StreamStarted
export type StreamStarted = typeof AgentEvent.StreamStarted.Type
export const StreamChunk = AgentEvent.StreamChunk
export type StreamChunk = typeof AgentEvent.StreamChunk.Type
export const StreamEnded = AgentEvent.StreamEnded
export type StreamEnded = typeof AgentEvent.StreamEnded.Type
export const TurnCompleted = AgentEvent.TurnCompleted
export type TurnCompleted = typeof AgentEvent.TurnCompleted.Type
export const TurnRecoveryApplied = AgentEvent.TurnRecoveryApplied
export type TurnRecoveryApplied = typeof AgentEvent.TurnRecoveryApplied.Type
export const ToolCallStarted = AgentEvent.ToolCallStarted
export type ToolCallStarted = typeof AgentEvent.ToolCallStarted.Type
export const ToolCallSucceeded = AgentEvent.ToolCallSucceeded
export type ToolCallSucceeded = typeof AgentEvent.ToolCallSucceeded.Type
export const ToolCallFailed = AgentEvent.ToolCallFailed
export type ToolCallFailed = typeof AgentEvent.ToolCallFailed.Type
export const InteractionPresented = AgentEvent.InteractionPresented
export type InteractionPresented = typeof AgentEvent.InteractionPresented.Type
export const InteractionResolved = AgentEvent.InteractionResolved
export type InteractionResolved = typeof AgentEvent.InteractionResolved.Type
export const ErrorOccurred = AgentEvent.ErrorOccurred
export type ErrorOccurred = typeof AgentEvent.ErrorOccurred.Type
export const ProviderRetrying = AgentEvent.ProviderRetrying
export type ProviderRetrying = typeof AgentEvent.ProviderRetrying.Type
export const MachineInspected = AgentEvent.MachineInspected
export type MachineInspected = typeof AgentEvent.MachineInspected.Type
export const MachineTaskSucceeded = AgentEvent.MachineTaskSucceeded
export type MachineTaskSucceeded = typeof AgentEvent.MachineTaskSucceeded.Type
export const MachineTaskFailed = AgentEvent.MachineTaskFailed
export type MachineTaskFailed = typeof AgentEvent.MachineTaskFailed.Type
export const SessionNameUpdated = AgentEvent.SessionNameUpdated
export type SessionNameUpdated = typeof AgentEvent.SessionNameUpdated.Type
export const SessionSettingsUpdated = AgentEvent.SessionSettingsUpdated
export type SessionSettingsUpdated = typeof AgentEvent.SessionSettingsUpdated.Type
export const BranchCreated = AgentEvent.BranchCreated
export type BranchCreated = typeof AgentEvent.BranchCreated.Type
export const BranchSwitched = AgentEvent.BranchSwitched
export type BranchSwitched = typeof AgentEvent.BranchSwitched.Type
export const BranchSummarized = AgentEvent.BranchSummarized
export type BranchSummarized = typeof AgentEvent.BranchSummarized.Type
export const AgentSwitched = AgentEvent.AgentSwitched
export type AgentSwitched = typeof AgentEvent.AgentSwitched.Type
export const AgentRunSpawned = AgentEvent.AgentRunSpawned
export type AgentRunSpawned = typeof AgentEvent.AgentRunSpawned.Type
export const AgentRunSucceeded = AgentEvent.AgentRunSucceeded
export type AgentRunSucceeded = typeof AgentEvent.AgentRunSucceeded.Type
export const AgentRunFailed = AgentEvent.AgentRunFailed
export type AgentRunFailed = typeof AgentEvent.AgentRunFailed.Type
export const TaskCreated = AgentEvent.TaskCreated
export type TaskCreated = typeof AgentEvent.TaskCreated.Type
export const TaskUpdated = AgentEvent.TaskUpdated
export type TaskUpdated = typeof AgentEvent.TaskUpdated.Type
export const TaskCompleted = AgentEvent.TaskCompleted
export type TaskCompleted = typeof AgentEvent.TaskCompleted.Type
export const TaskFailed = AgentEvent.TaskFailed
export type TaskFailed = typeof AgentEvent.TaskFailed.Type
export const TaskStopped = AgentEvent.TaskStopped
export type TaskStopped = typeof AgentEvent.TaskStopped.Type
export const TaskDeleted = AgentEvent.TaskDeleted
export type TaskDeleted = typeof AgentEvent.TaskDeleted.Type
export const AgentRestarted = AgentEvent.AgentRestarted
export type AgentRestarted = typeof AgentEvent.AgentRestarted.Type
export const ExtensionStateChanged = AgentEvent.ExtensionStateChanged
export type ExtensionStateChanged = typeof AgentEvent.ExtensionStateChanged.Type

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
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
  readonly subscribe: (params: {
    sessionId: SessionId
    branchId?: BranchId
    after?: EventId
  }) => Stream.Stream<EventEnvelope, EventStoreError>
  /** Remove session PubSub, shutting down any active subscribers. */
  readonly removeSession: (sessionId: SessionId) => Effect.Effect<void>
}

const matchEventSessionId = AgentEvent.match({
  SessionStarted: (e) => e.sessionId,
  MessageReceived: (e) => e.message.sessionId,
  StreamStarted: (e) => e.sessionId,
  StreamChunk: (e) => e.sessionId,
  StreamEnded: (e) => e.sessionId,
  TurnCompleted: (e) => e.sessionId,
  TurnRecoveryApplied: (e) => e.sessionId,
  ToolCallStarted: (e) => e.sessionId,
  ToolCallSucceeded: (e) => e.sessionId,
  ToolCallFailed: (e) => e.sessionId,
  InteractionPresented: (e) => e.sessionId,
  InteractionResolved: (e) => e.sessionId,
  ErrorOccurred: (e) => e.sessionId,
  ProviderRetrying: (e) => e.sessionId,
  MachineInspected: (e) => e.sessionId,
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
  TaskCreated: (e) => e.sessionId,
  TaskUpdated: (e) => e.sessionId,
  TaskCompleted: (e) => e.sessionId,
  TaskFailed: (e) => e.sessionId,
  TaskStopped: (e) => e.sessionId,
  TaskDeleted: (e) => e.sessionId,
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
  TurnRecoveryApplied: (e) => e.branchId,
  ToolCallStarted: (e) => e.branchId,
  ToolCallSucceeded: (e) => e.branchId,
  ToolCallFailed: (e) => e.branchId,
  InteractionPresented: (e) => e.branchId,
  InteractionResolved: (e) => e.branchId,
  ErrorOccurred: (e) => e.branchId,
  ProviderRetrying: (e) => e.branchId,
  MachineInspected: (e) => e.branchId,
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
  TaskCreated: (e) => e.branchId,
  TaskUpdated: (e) => e.branchId,
  TaskCompleted: (e) => e.branchId,
  TaskFailed: (e) => e.branchId,
  TaskStopped: (e) => e.branchId,
  TaskDeleted: (e) => e.branchId,
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
const matchesBranchFilter = (env: EventEnvelope, branchId?: BranchId): boolean => {
  if (branchId === undefined) return true
  const eventBranchId = getEventBranchId(env.event)
  return eventBranchId === branchId || eventBranchId === undefined
}

// EventStore Service

const getOrCreateSessionPubSub = (
  sessions: Map<SessionId, PubSub.PubSub<EventEnvelope>>,
  sessionId: SessionId,
): PubSub.PubSub<EventEnvelope> => {
  const existing = sessions.get(sessionId)
  if (existing !== undefined) return existing
  const ps = Effect.runSync(PubSub.unbounded<EventEnvelope>())
  sessions.set(sessionId, ps)
  return ps
}

const makeMemoryEventStore = Effect.gen(function* () {
  const sessions = new Map<SessionId, PubSub.PubSub<EventEnvelope>>()
  const eventsRef = yield* Ref.make<EventEnvelope[]>([])
  const idRef = yield* Ref.make(0)

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

    broadcast: (envelope) => {
      const eventSessionId = getEventSessionId(envelope.event)
      if (eventSessionId !== undefined) {
        return PubSub.publish(getOrCreateSessionPubSub(sessions, eventSessionId), envelope).pipe(
          Effect.asVoid,
        )
      }
      return Effect.void
    },

    publish: Effect.fn("EventStore.publish")(function* (event) {
      const envelope = yield* service.append(event)
      yield* service.broadcast(envelope)
    }),

    subscribe: ({ sessionId, branchId, after }) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const afterId = after ?? EventId.make(0)
            const ps = getOrCreateSessionPubSub(sessions, sessionId)
            const subscription = yield* PubSub.subscribe(ps)
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

    removeSession: (sessionId) =>
      Effect.gen(function* () {
        const ps = sessions.get(sessionId)
        if (ps !== undefined) {
          sessions.delete(sessionId)
          yield* PubSub.shutdown(ps)
        }
      }),
  }
  return service
})

export class EventStore extends Context.Service<EventStore, EventStoreService>()(
  "@gent/core/src/domain/event/EventStore",
) {
  static Memory: Layer.Layer<EventStore> = Layer.unwrap(
    makeMemoryEventStore.pipe(Effect.map((service) => Layer.succeed(EventStore, service))),
  )

  static Live: Layer.Layer<EventStore> = EventStore.Memory
}
