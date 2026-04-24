import { Clock, Context, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"

import { branded, BranchId, MessageId, SessionId, TaskId, ToolCallId } from "./ids"
import { ReasoningEffort } from "./agent"
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
// properties (`AgentEvent.cases.SessionStarted`) so construction reads
// `SessionStarted.make({...})`. Pattern-match via `Match.tag` or
// `_tag === "X"` works unchanged — the wire shape is identical.
// ============================================================================

export const AgentEvent = TaggedEnumClass("AgentEvent", {
  SessionStarted: {
    sessionId: SessionId,
    branchId: BranchId,
  },
  MessageReceived: {
    sessionId: SessionId,
    branchId: BranchId,
    messageId: MessageId,
    role: Schema.Literals(["user", "assistant", "system", "tool"]),
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
    fromAgent: Schema.String,
    toAgent: Schema.String,
  },
  AgentRunSpawned: {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: Schema.String,
    prompt: Schema.String,
    toolCallId: Schema.optional(ToolCallId),
    branchId: Schema.optional(BranchId),
    childBranchId: Schema.optional(BranchId),
  },
  AgentRunSucceeded: {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: Schema.String,
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
    agentName: Schema.String,
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
// Per-variant re-exports — same class identity as `AgentEvent.cases.X`, exposed at
// module scope so consumers may import variants directly without going
// through the enum object. `SessionStarted.make(...)` and
// `AgentEvent.cases.SessionStarted.make(...)` produce instances of the SAME class;
// these are aliases, not parallel implementations. Use whichever reads better
// at the call site — both communicate "variant of AgentEvent."
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
export const TurnRecoveryApplied = AgentEvent.cases.TurnRecoveryApplied
export type TurnRecoveryApplied = typeof AgentEvent.cases.TurnRecoveryApplied.Type
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
export const MachineInspected = AgentEvent.cases.MachineInspected
export type MachineInspected = typeof AgentEvent.cases.MachineInspected.Type
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
export const TaskCreated = AgentEvent.cases.TaskCreated
export type TaskCreated = typeof AgentEvent.cases.TaskCreated.Type
export const TaskUpdated = AgentEvent.cases.TaskUpdated
export type TaskUpdated = typeof AgentEvent.cases.TaskUpdated.Type
export const TaskCompleted = AgentEvent.cases.TaskCompleted
export type TaskCompleted = typeof AgentEvent.cases.TaskCompleted.Type
export const TaskFailed = AgentEvent.cases.TaskFailed
export type TaskFailed = typeof AgentEvent.cases.TaskFailed.Type
export const TaskStopped = AgentEvent.cases.TaskStopped
export type TaskStopped = typeof AgentEvent.cases.TaskStopped.Type
export const TaskDeleted = AgentEvent.cases.TaskDeleted
export type TaskDeleted = typeof AgentEvent.cases.TaskDeleted.Type
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
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
  readonly subscribe: (params: {
    sessionId: SessionId
    branchId?: BranchId
    after?: EventId
  }) => Stream.Stream<EventEnvelope, EventStoreError>
  /** Remove session PubSub, shutting down any active subscribers. */
  readonly removeSession: (sessionId: SessionId) => Effect.Effect<void>
}

export const getEventSessionId = (event: AgentEvent): SessionId | undefined => {
  if ("sessionId" in event) return SessionId.make(event.sessionId)
  if ("parentSessionId" in event) return SessionId.make(event.parentSessionId)
  return undefined
}

export const getEventBranchId = (event: AgentEvent): BranchId | undefined => {
  if ("branchId" in event) return event.branchId as BranchId | undefined
  return undefined
}

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
  const eventBranchId =
    "branchId" in env.event ? (env.event.branchId as BranchId | undefined) : undefined
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
