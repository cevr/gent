import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"

// Event Types

export class SessionStarted extends Schema.TaggedClass<SessionStarted>()("SessionStarted", {
  sessionId: Schema.String,
  branchId: Schema.String,
}) {}

export class SessionEnded extends Schema.TaggedClass<SessionEnded>()("SessionEnded", {
  sessionId: Schema.String,
}) {}

export class MessageReceived extends Schema.TaggedClass<MessageReceived>()("MessageReceived", {
  sessionId: Schema.String,
  branchId: Schema.String,
  messageId: Schema.String,
  role: Schema.Literal("user", "assistant", "system", "tool"),
}) {}

export class StreamStarted extends Schema.TaggedClass<StreamStarted>()("StreamStarted", {
  sessionId: Schema.String,
  branchId: Schema.String,
}) {}

export class StreamChunk extends Schema.TaggedClass<StreamChunk>()("StreamChunk", {
  sessionId: Schema.String,
  branchId: Schema.String,
  chunk: Schema.String,
}) {}

export const UsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
})
export type Usage = typeof UsageSchema.Type

export class StreamEnded extends Schema.TaggedClass<StreamEnded>()("StreamEnded", {
  sessionId: Schema.String,
  branchId: Schema.String,
  usage: Schema.optional(UsageSchema),
  interrupted: Schema.optional(Schema.Boolean),
}) {}

export class ToolCallStarted extends Schema.TaggedClass<ToolCallStarted>()("ToolCallStarted", {
  sessionId: Schema.String,
  branchId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.optional(Schema.Unknown),
}) {}

export class ToolCallCompleted extends Schema.TaggedClass<ToolCallCompleted>()(
  "ToolCallCompleted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    toolCallId: Schema.String,
    toolName: Schema.String,
    isError: Schema.Boolean,
    summary: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
  },
) {}

export class PlanModeEntered extends Schema.TaggedClass<PlanModeEntered>()("PlanModeEntered", {
  sessionId: Schema.String,
  branchId: Schema.String,
}) {}

export class PermissionRequested extends Schema.TaggedClass<PermissionRequested>()(
  "PermissionRequested",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    requestId: Schema.String,
    toolCallId: Schema.String,
    toolName: Schema.String,
    input: Schema.optional(Schema.Unknown),
  },
) {}

export class PlanPresented extends Schema.TaggedClass<PlanPresented>()("PlanPresented", {
  sessionId: Schema.String,
  branchId: Schema.String,
  requestId: Schema.String,
  planPath: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
}) {}

export class PlanConfirmed extends Schema.TaggedClass<PlanConfirmed>()("PlanConfirmed", {
  sessionId: Schema.String,
  branchId: Schema.String,
  requestId: Schema.String,
  planPath: Schema.optional(Schema.String),
}) {}

export class PlanRejected extends Schema.TaggedClass<PlanRejected>()("PlanRejected", {
  sessionId: Schema.String,
  branchId: Schema.String,
  requestId: Schema.String,
  planPath: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
}) {}

export const PlanDecision = Schema.Literal("confirm", "reject")
export type PlanDecision = typeof PlanDecision.Type

export class CompactionStarted extends Schema.TaggedClass<CompactionStarted>()(
  "CompactionStarted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
  },
) {}

export class CompactionCompleted extends Schema.TaggedClass<CompactionCompleted>()(
  "CompactionCompleted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    compactionId: Schema.String,
  },
) {}

export class ErrorOccurred extends Schema.TaggedClass<ErrorOccurred>()("ErrorOccurred", {
  sessionId: Schema.String,
  branchId: Schema.optional(Schema.String),
  error: Schema.String,
}) {}

export class TodoUpdated extends Schema.TaggedClass<TodoUpdated>()("TodoUpdated", {
  sessionId: Schema.String,
  branchId: Schema.String,
}) {}

export const QuestionOptionSchema = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export type QuestionOption = typeof QuestionOptionSchema.Type

export const QuestionSchema = Schema.Struct({
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(QuestionOptionSchema)),
  multiple: Schema.optional(Schema.Boolean),
})
export type Question = typeof QuestionSchema.Type

export class QuestionsAsked extends Schema.TaggedClass<QuestionsAsked>()("QuestionsAsked", {
  sessionId: Schema.String,
  branchId: Schema.String,
  requestId: Schema.String,
  questions: Schema.Array(QuestionSchema),
}) {}

export class QuestionsAnswered extends Schema.TaggedClass<QuestionsAnswered>()(
  "QuestionsAnswered",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    requestId: Schema.String,
    answers: Schema.Array(Schema.Array(Schema.String)),
  },
) {}

export class SessionNameUpdated extends Schema.TaggedClass<SessionNameUpdated>()(
  "SessionNameUpdated",
  {
    sessionId: Schema.String,
    name: Schema.String,
  },
) {}

export class ModelChanged extends Schema.TaggedClass<ModelChanged>()("ModelChanged", {
  sessionId: Schema.String,
  branchId: Schema.String,
  model: Schema.String,
}) {}

export const AgentEvent = Schema.Union(
  SessionStarted,
  SessionEnded,
  MessageReceived,
  StreamStarted,
  StreamChunk,
  StreamEnded,
  ToolCallStarted,
  ToolCallCompleted,
  PlanModeEntered,
  PermissionRequested,
  PlanPresented,
  PlanConfirmed,
  PlanRejected,
  CompactionStarted,
  CompactionCompleted,
  ErrorOccurred,
  TodoUpdated,
  QuestionsAsked,
  QuestionsAnswered,
  SessionNameUpdated,
  ModelChanged,
)
export type AgentEvent = typeof AgentEvent.Type

// EventBus Service

export interface EventBusService {
  readonly publish: (event: AgentEvent) => Effect.Effect<void>
  readonly subscribe: () => Stream.Stream<AgentEvent>
}

export class EventBus extends Context.Tag("EventBus")<EventBus, EventBusService>() {
  static Live: Layer.Layer<EventBus> = Layer.scoped(
    EventBus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<AgentEvent>()
      return {
        publish: (event) => PubSub.publish(pubsub, event),
        subscribe: () =>
          Stream.unwrapScoped(
            PubSub.subscribe(pubsub).pipe(Effect.map((queue) => Stream.fromQueue(queue))),
          ),
      }
    }),
  )

  static Test = (): Layer.Layer<EventBus> =>
    Layer.succeed(EventBus, {
      publish: () => Effect.void,
      subscribe: () => Stream.empty,
    })
}
