import { ServiceMap, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"

import { BranchId, MessageId, SessionId, TaskId, ToolCallId } from "./ids"

// Event Types

export class SessionStarted extends Schema.TaggedClass<SessionStarted>()("SessionStarted", {
  sessionId: SessionId,
  branchId: BranchId,
}) {}

export class SessionEnded extends Schema.TaggedClass<SessionEnded>()("SessionEnded", {
  sessionId: SessionId,
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

export class ToolCallStarted extends Schema.TaggedClass<ToolCallStarted>()("ToolCallStarted", {
  sessionId: SessionId,
  branchId: BranchId,
  toolCallId: ToolCallId,
  toolName: Schema.String,
  input: Schema.optional(Schema.Unknown),
}) {}

/** @deprecated Use ToolCallSucceeded or ToolCallFailed instead */
export class ToolCallCompleted extends Schema.TaggedClass<ToolCallCompleted>()(
  "ToolCallCompleted",
  {
    sessionId: SessionId,
    branchId: BranchId,
    toolCallId: ToolCallId,
    toolName: Schema.String,
    isError: Schema.Boolean,
    summary: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
  },
) {}

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
  "@machine.error",
  "@machine.stop",
])
export type MachineInspectionType = typeof MachineInspectionType.Type

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

export class TodoUpdated extends Schema.TaggedClass<TodoUpdated>()("TodoUpdated", {
  sessionId: SessionId,
  branchId: BranchId,
}) {}

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

export class QuestionsAnswered extends Schema.TaggedClass<QuestionsAnswered>()(
  "QuestionsAnswered",
  {
    sessionId: SessionId,
    branchId: BranchId,
    requestId: Schema.String,
    answers: Schema.Array(Schema.Array(Schema.String)),
  },
) {}

export class SessionNameUpdated extends Schema.TaggedClass<SessionNameUpdated>()(
  "SessionNameUpdated",
  {
    sessionId: SessionId,
    name: Schema.String,
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

/** @deprecated Use SubagentSucceeded or SubagentFailed instead */
export class SubagentCompleted extends Schema.TaggedClass<SubagentCompleted>()(
  "SubagentCompleted",
  {
    parentSessionId: SessionId,
    childSessionId: SessionId,
    agentName: Schema.String,
    success: Schema.Boolean,
  },
) {}

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

// Workflow Events

export class WorkflowPhaseStarted extends Schema.TaggedClass<WorkflowPhaseStarted>()(
  "WorkflowPhaseStarted",
  {
    sessionId: SessionId,
    branchId: BranchId,
    workflowName: Schema.String,
    phase: Schema.String,
    iteration: Schema.optional(Schema.Number),
    maxIterations: Schema.optional(Schema.Number),
    metadata: Schema.optional(Schema.Unknown),
  },
) {}

export class WorkflowCompleted extends Schema.TaggedClass<WorkflowCompleted>()(
  "WorkflowCompleted",
  {
    sessionId: SessionId,
    branchId: BranchId,
    workflowName: Schema.String,
    result: Schema.Literals(["success", "rejected", "error", "max_iterations"]),
  },
) {}

export const AgentEvent = Schema.Union([
  SessionStarted,
  SessionEnded,
  MessageReceived,
  StreamStarted,
  StreamChunk,
  StreamEnded,
  TurnCompleted,
  ToolCallStarted,
  ToolCallCompleted,
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
  TodoUpdated,
  QuestionsAsked,
  QuestionsAnswered,
  SessionNameUpdated,
  BranchCreated,
  BranchSwitched,
  BranchSummarized,
  AgentSwitched,
  SubagentSpawned,
  SubagentCompleted,
  SubagentSucceeded,
  SubagentFailed,
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskDeleted,
  AgentRestarted,
  WorkflowPhaseStarted,
  WorkflowCompleted,
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
}

export const getEventSessionId = (event: AgentEvent): SessionId | undefined => {
  if ("sessionId" in event) return event.sessionId as SessionId
  if ("parentSessionId" in event) return event.parentSessionId as SessionId
  return undefined
}

export const matchesEventFilter = (
  env: EventEnvelope,
  sessionId: SessionId,
  branchId?: BranchId,
): boolean => {
  const eventSessionId = getEventSessionId(env.event)
  if (eventSessionId === undefined || eventSessionId !== sessionId) return false
  if (branchId === undefined) return true
  const eventBranchId =
    "branchId" in env.event ? (env.event.branchId as BranchId | undefined) : undefined
  return eventBranchId === branchId || eventBranchId === undefined
}

// EventStore Service

export class EventStore extends ServiceMap.Service<EventStore, EventStoreService>()(
  "@gent/core/src/event/EventStore",
) {
  static Memory: Layer.Layer<EventStore> = Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<EventEnvelope>()
      const eventsRef = yield* Ref.make<EventEnvelope[]>([])
      const idRef = yield* Ref.make(0)

      return {
        publish: Effect.fn("EventStore.publish")(function* (event) {
          const id = yield* Ref.modify(idRef, (n) => [n + 1, n + 1])
          const currentSpan = yield* Effect.currentParentSpan.pipe(
            Effect.orElseSucceed(() => undefined),
          )
          const envelope = new EventEnvelope({
            id: id as EventId,
            event,
            createdAt: Date.now(),
            ...(currentSpan !== undefined ? { traceId: currentSpan.traceId } : {}),
          })
          yield* Ref.update(eventsRef, (events) => [...events, envelope])
          yield* PubSub.publish(pubsub, envelope)
        }),

        subscribe: ({ sessionId, branchId, after }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* PubSub.subscribe(pubsub)
              const afterId = after ?? (0 as EventId)
              const latestId = yield* Ref.get(idRef)
              const buffered = (yield* Ref.get(eventsRef)).filter(
                (env) =>
                  env.id > afterId &&
                  env.id <= latestId &&
                  matchesEventFilter(env, sessionId, branchId),
              )
              const live = Stream.fromSubscription(queue).pipe(
                Stream.filter(
                  (env) => env.id > latestId && matchesEventFilter(env, sessionId, branchId),
                ),
              )
              return Stream.concat(Stream.fromIterable(buffered), live)
            }),
          ),
      }
    }),
  )

  static Live: Layer.Layer<EventStore> = EventStore.Memory

  static Test = (): Layer.Layer<EventStore> =>
    Layer.succeed(EventStore, {
      publish: () => Effect.void,
      subscribe: (_params) => Stream.empty,
    })
}
