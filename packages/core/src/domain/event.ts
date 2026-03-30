import { Clock, ServiceMap, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"

import { BranchId, MessageId, SessionId, TaskId, ToolCallId } from "./ids"
import { ReasoningEffort } from "./agent"

// Event Types

export class SessionStarted extends Schema.TaggedClass<SessionStarted>()("SessionStarted", {
  sessionId: SessionId,
  branchId: BranchId,
}) {}

export class MessageReceived extends Schema.TaggedClass<MessageReceived>()("MessageReceived", {
  sessionId: SessionId,
  branchId: BranchId,
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
}) {}

export class StreamStarted extends Schema.TaggedClass<StreamStarted>()("StreamStarted", {
  sessionId: SessionId,
  branchId: BranchId,
}) {}

export class StreamChunk extends Schema.TaggedClass<StreamChunk>()("StreamChunk", {
  sessionId: SessionId,
  branchId: BranchId,
  chunk: Schema.String,
}) {}

export const UsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
})
export type Usage = typeof UsageSchema.Type

export class StreamEnded extends Schema.TaggedClass<StreamEnded>()("StreamEnded", {
  sessionId: SessionId,
  branchId: BranchId,
  usage: Schema.optional(UsageSchema),
  interrupted: Schema.optional(Schema.Boolean),
}) {}

export class TurnCompleted extends Schema.TaggedClass<TurnCompleted>()("TurnCompleted", {
  sessionId: SessionId,
  branchId: BranchId,
  durationMs: Schema.Number,
  interrupted: Schema.optional(Schema.Boolean),
}) {}

export const RecoveryPhase = Schema.Literals([
  "Idle",
  "Resolving",
  "Streaming",
  "ExecutingTools",
  "Finalizing",
])
export type RecoveryPhase = typeof RecoveryPhase.Type

export const RecoveryAction = Schema.Literals([
  "resume-queued-turn",
  "replay-resolving",
  "replay-streaming",
  "reuse-persisted-assistant",
  "replay-idempotent-tools",
  "reuse-persisted-tool-results",
  "abort-non-idempotent-tools",
  "replay-finalizing",
])
export type RecoveryAction = typeof RecoveryAction.Type

export class TurnRecoveryApplied extends Schema.TaggedClass<TurnRecoveryApplied>()(
  "TurnRecoveryApplied",
  {
    sessionId: SessionId,
    branchId: BranchId,
    phase: RecoveryPhase,
    action: RecoveryAction,
    detail: Schema.optional(Schema.String),
  },
) {}

export class ToolCallStarted extends Schema.TaggedClass<ToolCallStarted>()("ToolCallStarted", {
  sessionId: SessionId,
  branchId: BranchId,
  toolCallId: ToolCallId,
  toolName: Schema.String,
  input: Schema.optional(Schema.Unknown),
}) {}

export class ToolCallSucceeded extends Schema.TaggedClass<ToolCallSucceeded>()(
  "ToolCallSucceeded",
  {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    summary: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
  },
) {}

export class ToolCallFailed extends Schema.TaggedClass<ToolCallFailed>()("ToolCallFailed", {
  sessionId: SessionId,
  branchId: BranchId,
  toolCallId: ToolCallId,
  toolName: Schema.String,
  summary: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
}) {}

export class PermissionRequested extends Schema.TaggedClass<PermissionRequested>()(
  "PermissionRequested",
  {
    sessionId: SessionId,
    branchId: BranchId,
    requestId: Schema.String,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    input: Schema.optional(Schema.Unknown),
  },
) {}

export class PromptPresented extends Schema.TaggedClass<PromptPresented>()("PromptPresented", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  mode: Schema.Literals(["present", "confirm", "review"]),
  path: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
}) {}

export class PromptConfirmed extends Schema.TaggedClass<PromptConfirmed>()("PromptConfirmed", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export class PromptRejected extends Schema.TaggedClass<PromptRejected>()("PromptRejected", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  path: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
}) {}

export class PromptEdited extends Schema.TaggedClass<PromptEdited>()("PromptEdited", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export const PromptDecision = Schema.Literals(["yes", "no", "edit"])
export type PromptDecision = typeof PromptDecision.Type

export class HandoffPresented extends Schema.TaggedClass<HandoffPresented>()("HandoffPresented", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  summary: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

export class HandoffConfirmed extends Schema.TaggedClass<HandoffConfirmed>()("HandoffConfirmed", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  childSessionId: Schema.optional(SessionId),
}) {}

export class HandoffRejected extends Schema.TaggedClass<HandoffRejected>()("HandoffRejected", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

export const HandoffDecision = Schema.Literals(["confirm", "reject"])
export type HandoffDecision = typeof HandoffDecision.Type

export class ErrorOccurred extends Schema.TaggedClass<ErrorOccurred>()("ErrorOccurred", {
  sessionId: SessionId,
  branchId: Schema.optional(BranchId),
  error: Schema.String,
}) {}

export class ProviderRetrying extends Schema.TaggedClass<ProviderRetrying>()("ProviderRetrying", {
  sessionId: SessionId,
  branchId: BranchId,
  attempt: Schema.Int,
  maxAttempts: Schema.Int,
  delayMs: Schema.Int,
  error: Schema.String,
}) {}

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
export class MachineInspected extends Schema.TaggedClass<MachineInspected>()("MachineInspected", {
  sessionId: SessionId,
  branchId: BranchId,
  actorId: Schema.String,
  inspectionType: MachineInspectionType,
  payload: Schema.Unknown,
}) {}

export class MachineTaskSucceeded extends Schema.TaggedClass<MachineTaskSucceeded>()(
  "MachineTaskSucceeded",
  {
    sessionId: SessionId,
    branchId: BranchId,
    actorId: Schema.String,
    stateTag: Schema.String,
  },
) {}

export class MachineTaskFailed extends Schema.TaggedClass<MachineTaskFailed>()(
  "MachineTaskFailed",
  {
    sessionId: SessionId,
    branchId: BranchId,
    actorId: Schema.String,
    stateTag: Schema.String,
    error: Schema.String,
  },
) {}

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

export class QuestionsAsked extends Schema.TaggedClass<QuestionsAsked>()("QuestionsAsked", {
  sessionId: SessionId,
  branchId: BranchId,
  requestId: Schema.String,
  questions: Schema.Array(QuestionSchema),
}) {}

export class SessionNameUpdated extends Schema.TaggedClass<SessionNameUpdated>()(
  "SessionNameUpdated",
  {
    sessionId: SessionId,
    name: Schema.String,
  },
) {}

export class SessionSettingsUpdated extends Schema.TaggedClass<SessionSettingsUpdated>()(
  "SessionSettingsUpdated",
  {
    sessionId: SessionId,
    bypass: Schema.optional(Schema.Boolean),
    reasoningLevel: Schema.optional(ReasoningEffort),
  },
) {}

export class BranchCreated extends Schema.TaggedClass<BranchCreated>()("BranchCreated", {
  sessionId: SessionId,
  branchId: BranchId,
  parentBranchId: Schema.optional(BranchId),
  parentMessageId: Schema.optional(MessageId),
}) {}

export class BranchSwitched extends Schema.TaggedClass<BranchSwitched>()("BranchSwitched", {
  sessionId: SessionId,
  fromBranchId: BranchId,
  toBranchId: BranchId,
}) {}

export class BranchSummarized extends Schema.TaggedClass<BranchSummarized>()("BranchSummarized", {
  sessionId: SessionId,
  branchId: BranchId,
  summary: Schema.String,
}) {}

export class AgentSwitched extends Schema.TaggedClass<AgentSwitched>()("AgentSwitched", {
  sessionId: SessionId,
  branchId: BranchId,
  fromAgent: Schema.String,
  toAgent: Schema.String,
}) {}

export class SubagentSpawned extends Schema.TaggedClass<SubagentSpawned>()("SubagentSpawned", {
  parentSessionId: SessionId,
  childSessionId: SessionId,
  agentName: Schema.String,
  prompt: Schema.String,
  toolCallId: Schema.optional(ToolCallId),
  branchId: Schema.optional(BranchId),
}) {}

export class SubagentSucceeded extends Schema.TaggedClass<SubagentSucceeded>()(
  "SubagentSucceeded",
  {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: Schema.String,
    toolCallId: Schema.optional(ToolCallId),
    branchId: Schema.optional(BranchId),
  },
) {}

export class SubagentFailed extends Schema.TaggedClass<SubagentFailed>()("SubagentFailed", {
  parentSessionId: SessionId,
  childSessionId: SessionId,
  agentName: Schema.String,
  toolCallId: Schema.optional(ToolCallId),
  branchId: Schema.optional(BranchId),
}) {}

// Task events

export class TaskCreated extends Schema.TaggedClass<TaskCreated>()("TaskCreated", {
  sessionId: SessionId,
  branchId: BranchId,
  taskId: TaskId,
  subject: Schema.String,
}) {}

export class TaskUpdated extends Schema.TaggedClass<TaskUpdated>()("TaskUpdated", {
  sessionId: SessionId,
  branchId: BranchId,
  taskId: TaskId,
  status: Schema.String,
}) {}

export class TaskCompleted extends Schema.TaggedClass<TaskCompleted>()("TaskCompleted", {
  sessionId: SessionId,
  branchId: BranchId,
  taskId: TaskId,
  owner: Schema.optional(SessionId),
}) {}

export class TaskFailed extends Schema.TaggedClass<TaskFailed>()("TaskFailed", {
  sessionId: SessionId,
  branchId: BranchId,
  taskId: TaskId,
  error: Schema.optional(Schema.String),
}) {}

export class TaskDeleted extends Schema.TaggedClass<TaskDeleted>()("TaskDeleted", {
  sessionId: SessionId,
  branchId: BranchId,
  taskId: TaskId,
}) {}

export class AgentRestarted extends Schema.TaggedClass<AgentRestarted>()("AgentRestarted", {
  sessionId: SessionId,
  branchId: BranchId,
  attempt: Schema.Number,
  error: Schema.optional(Schema.String),
}) {}

// Extension State Events

export class ExtensionUiSnapshot extends Schema.TaggedClass<ExtensionUiSnapshot>()(
  "ExtensionUiSnapshot",
  {
    sessionId: SessionId,
    branchId: BranchId,
    extensionId: Schema.String,
    /** Monotonic version for intent staleness detection */
    epoch: Schema.Number,
    /** Serialized uiModel from derive() — schema-validated per extension */
    model: Schema.Unknown,
  },
) {}

// ============================================================================
// Interaction types — shared between server and client
// ============================================================================

/** Event tags that represent interactive prompts requiring user response */
export type InteractionEventTag =
  | "QuestionsAsked"
  | "PermissionRequested"
  | "PromptPresented"
  | "HandoffPresented"

/** Active interaction — raw event discriminated union for interaction rendering */
export type ActiveInteraction =
  | (typeof QuestionsAsked.Type & { readonly _tag: "QuestionsAsked" })
  | (typeof PermissionRequested.Type & { readonly _tag: "PermissionRequested" })
  | (typeof PromptPresented.Type & { readonly _tag: "PromptPresented" })
  | (typeof HandoffPresented.Type & { readonly _tag: "HandoffPresented" })

/** Concrete resolution payloads per interaction tag */
export type InteractionResolutionByTag = {
  readonly QuestionsAsked:
    | { readonly _tag: "answered"; readonly answers: ReadonlyArray<ReadonlyArray<string>> }
    | { readonly _tag: "cancelled" }
  readonly PermissionRequested:
    | { readonly _tag: "allow"; readonly persist: boolean }
    | { readonly _tag: "deny"; readonly persist: boolean }
  readonly PromptPresented:
    | { readonly _tag: "yes" }
    | { readonly _tag: "no"; readonly reason?: string }
    | { readonly _tag: "edit" }
  readonly HandoffPresented:
    | { readonly _tag: "confirm" }
    | { readonly _tag: "reject"; readonly reason?: string }
}

/** Resolution payload for a specific interaction tag */
export type InteractionResolution<T extends InteractionEventTag> = InteractionResolutionByTag[T]

/** Extract the active interaction for a specific tag */
export type ActiveInteractionOf<T extends InteractionEventTag> = Extract<
  ActiveInteraction,
  { readonly _tag: T }
>

export class InteractionDismissed extends Schema.TaggedClass<InteractionDismissed>()(
  "InteractionDismissed",
  {
    sessionId: SessionId,
    branchId: BranchId,
    requestId: Schema.String,
  },
) {}

export const AgentEvent = Schema.Union([
  SessionStarted,
  MessageReceived,
  StreamStarted,
  StreamChunk,
  StreamEnded,
  TurnCompleted,
  TurnRecoveryApplied,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
  PermissionRequested,
  PromptPresented,
  PromptConfirmed,
  PromptRejected,
  PromptEdited,
  HandoffPresented,
  HandoffConfirmed,
  HandoffRejected,
  ErrorOccurred,
  ProviderRetrying,
  MachineInspected,
  MachineTaskSucceeded,
  MachineTaskFailed,
  QuestionsAsked,
  SessionNameUpdated,
  SessionSettingsUpdated,
  BranchCreated,
  BranchSwitched,
  BranchSummarized,
  AgentSwitched,
  SubagentSpawned,
  SubagentSucceeded,
  SubagentFailed,
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskDeleted,
  AgentRestarted,
  ExtensionUiSnapshot,
  InteractionDismissed,
])
export type AgentEvent = typeof AgentEvent.Type

export const EventId = Schema.Number.pipe(Schema.brand("EventId"))
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
  if ("sessionId" in event) return event.sessionId as SessionId
  if ("parentSessionId" in event) return event.parentSessionId as SessionId
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

/**
 * BaseEventStore — raw storage-backed publisher.
 * Used directly for synthetic events (ExtensionUiSnapshot) to avoid recursion.
 * Production code should use EventStore which wraps this with extension reduce.
 */
export class BaseEventStore extends ServiceMap.Service<BaseEventStore, EventStoreService>()(
  "@gent/core/src/domain/event/BaseEventStore",
) {}

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
    publish: Effect.fn("EventStore.publish")(function* (event) {
      const id = yield* Ref.modify(idRef, (n) => [n + 1, n + 1])
      const currentSpan = yield* Effect.currentParentSpan.pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const envelope = new EventEnvelope({
        id: id as EventId,
        event,
        createdAt: yield* Clock.currentTimeMillis,
        ...(currentSpan !== undefined ? { traceId: currentSpan.traceId } : {}),
      })
      yield* Ref.update(eventsRef, (events) => [...events, envelope])
      const eventSessionId = getEventSessionId(event)
      if (eventSessionId !== undefined) {
        yield* PubSub.publish(getOrCreateSessionPubSub(sessions, eventSessionId), envelope)
      }
    }),

    subscribe: ({ sessionId, branchId, after }) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const afterId = after ?? (0 as EventId)
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

export class EventStore extends ServiceMap.Service<EventStore, EventStoreService>()(
  "@gent/core/src/domain/event/EventStore",
) {
  static Memory: Layer.Layer<EventStore | BaseEventStore> = Layer.unwrap(
    makeMemoryEventStore.pipe(
      Effect.map((service) =>
        Layer.merge(Layer.succeed(EventStore, service), Layer.succeed(BaseEventStore, service)),
      ),
    ),
  )

  static Live: Layer.Layer<EventStore | BaseEventStore> = EventStore.Memory

  static Test = (): Layer.Layer<EventStore | BaseEventStore> => {
    const noop: EventStoreService = {
      publish: () => Effect.void,
      subscribe: (_params) => Stream.empty,
      removeSession: () => Effect.void,
    }
    return Layer.merge(Layer.succeed(EventStore, noop), Layer.succeed(BaseEventStore, noop))
  }
}
