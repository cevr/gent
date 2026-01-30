import { Context, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"

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

export class TurnCompleted extends Schema.TaggedClass<TurnCompleted>()("TurnCompleted", {
  sessionId: Schema.String,
  branchId: Schema.String,
  durationMs: Schema.Number,
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

export const MachineInspectionType = Schema.Literal(
  "@machine.spawn",
  "@machine.event",
  "@machine.transition",
  "@machine.effect",
  "@machine.error",
  "@machine.stop",
)
export type MachineInspectionType = typeof MachineInspectionType.Type

export class MachineInspected extends Schema.TaggedClass<MachineInspected>()("MachineInspected", {
  sessionId: Schema.String,
  branchId: Schema.String,
  actorId: Schema.String,
  inspectionType: MachineInspectionType,
  payload: Schema.Unknown,
}) {}

export class MachineTaskSucceeded extends Schema.TaggedClass<MachineTaskSucceeded>()(
  "MachineTaskSucceeded",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    actorId: Schema.String,
    stateTag: Schema.String,
  },
) {}

export class MachineTaskFailed extends Schema.TaggedClass<MachineTaskFailed>()(
  "MachineTaskFailed",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    actorId: Schema.String,
    stateTag: Schema.String,
    error: Schema.String,
  },
) {}

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
  markdown: Schema.optional(Schema.String),
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

export class BranchCreated extends Schema.TaggedClass<BranchCreated>()("BranchCreated", {
  sessionId: Schema.String,
  branchId: Schema.String,
  parentBranchId: Schema.optional(Schema.String),
  parentMessageId: Schema.optional(Schema.String),
}) {}

export class BranchSwitched extends Schema.TaggedClass<BranchSwitched>()("BranchSwitched", {
  sessionId: Schema.String,
  fromBranchId: Schema.String,
  toBranchId: Schema.String,
}) {}

export class BranchSummarized extends Schema.TaggedClass<BranchSummarized>()("BranchSummarized", {
  sessionId: Schema.String,
  branchId: Schema.String,
  summary: Schema.String,
}) {}

export class ModelChanged extends Schema.TaggedClass<ModelChanged>()("ModelChanged", {
  sessionId: Schema.String,
  branchId: Schema.String,
  model: Schema.String,
}) {}

export class AgentSwitched extends Schema.TaggedClass<AgentSwitched>()("AgentSwitched", {
  sessionId: Schema.String,
  branchId: Schema.String,
  fromAgent: Schema.String,
  toAgent: Schema.String,
}) {}

export class SubagentSpawned extends Schema.TaggedClass<SubagentSpawned>()("SubagentSpawned", {
  parentSessionId: Schema.String,
  childSessionId: Schema.String,
  agentName: Schema.String,
  prompt: Schema.String,
}) {}

export class SubagentCompleted extends Schema.TaggedClass<SubagentCompleted>()(
  "SubagentCompleted",
  {
    parentSessionId: Schema.String,
    childSessionId: Schema.String,
    agentName: Schema.String,
    success: Schema.Boolean,
  },
) {}

export const AgentEvent = Schema.Union(
  SessionStarted,
  SessionEnded,
  MessageReceived,
  StreamStarted,
  StreamChunk,
  StreamEnded,
  TurnCompleted,
  ToolCallStarted,
  ToolCallCompleted,
  PermissionRequested,
  PlanPresented,
  PlanConfirmed,
  PlanRejected,
  CompactionStarted,
  CompactionCompleted,
  ErrorOccurred,
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
  ModelChanged,
  AgentSwitched,
  SubagentSpawned,
  SubagentCompleted,
)
export type AgentEvent = typeof AgentEvent.Type

export const EventId = Schema.Number.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

export class EventEnvelope extends Schema.Class<EventEnvelope>("EventEnvelope")({
  id: EventId,
  event: AgentEvent,
  createdAt: Schema.Number,
}) {}

export class EventStoreError extends Schema.TaggedError<EventStoreError>()("EventStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface EventStoreService {
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
  readonly subscribe: (params: {
    sessionId: string
    branchId?: string
    after?: EventId
  }) => Stream.Stream<EventEnvelope, EventStoreError>
}

const getEventSessionId = (event: AgentEvent): string | undefined => {
  if ("sessionId" in event) return event.sessionId as string
  if ("parentSessionId" in event) return event.parentSessionId as string
  return undefined
}

const matchesEventFilter = (env: EventEnvelope, sessionId: string, branchId?: string): boolean => {
  const eventSessionId = getEventSessionId(env.event)
  if (eventSessionId === undefined || eventSessionId !== sessionId) return false
  if (branchId === undefined) return true
  const eventBranchId =
    "branchId" in env.event ? (env.event.branchId as string | undefined) : undefined
  return eventBranchId === branchId || eventBranchId === undefined
}

// EventStore Service

export class EventStore extends Context.Tag("@gent/core/src/event/EventStore")<
  EventStore,
  EventStoreService
>() {
  static Live: Layer.Layer<EventStore> = Layer.scoped(
    EventStore,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<EventEnvelope>()
      const eventsRef = yield* Ref.make<EventEnvelope[]>([])
      const idRef = yield* Ref.make(0)

      return {
        publish: Effect.fn("EventStore.publish")(function* (event) {
          const id = yield* Ref.modify(idRef, (n) => [n + 1, n + 1])
          const envelope = new EventEnvelope({
            id: id as EventId,
            event,
            createdAt: Date.now(),
          })
          yield* Ref.update(eventsRef, (events) => [...events, envelope])
          yield* PubSub.publish(pubsub, envelope)
        }),

        subscribe: ({ sessionId, branchId, after }) =>
          Stream.unwrapScoped(
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
              const live = Stream.fromQueue(queue).pipe(
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

  static Test = (): Layer.Layer<EventStore> =>
    Layer.succeed(EventStore, {
      publish: () => Effect.void,
      subscribe: (_params) => Stream.empty,
    })
}
