import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"

// Event Types

export class SessionStarted extends Schema.TaggedClass<SessionStarted>()(
  "SessionStarted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
  }
) {}

export class SessionEnded extends Schema.TaggedClass<SessionEnded>()(
  "SessionEnded",
  {
    sessionId: Schema.String,
  }
) {}

export class MessageReceived extends Schema.TaggedClass<MessageReceived>()(
  "MessageReceived",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    messageId: Schema.String,
    role: Schema.Literal("user", "assistant", "system"),
  }
) {}

export class StreamStarted extends Schema.TaggedClass<StreamStarted>()(
  "StreamStarted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
  }
) {}

export class StreamChunk extends Schema.TaggedClass<StreamChunk>()(
  "StreamChunk",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    chunk: Schema.String,
  }
) {}

export class StreamEnded extends Schema.TaggedClass<StreamEnded>()(
  "StreamEnded",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
  }
) {}

export class ToolCallStarted extends Schema.TaggedClass<ToolCallStarted>()(
  "ToolCallStarted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    toolCallId: Schema.String,
    toolName: Schema.String,
  }
) {}

export class ToolCallCompleted extends Schema.TaggedClass<ToolCallCompleted>()(
  "ToolCallCompleted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    toolCallId: Schema.String,
    toolName: Schema.String,
    isError: Schema.Boolean,
  }
) {}

export class PlanModeEntered extends Schema.TaggedClass<PlanModeEntered>()(
  "PlanModeEntered",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
  }
) {}

export class PlanModeExited extends Schema.TaggedClass<PlanModeExited>()(
  "PlanModeExited",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    planPath: Schema.String,
  }
) {}

export class PlanApproved extends Schema.TaggedClass<PlanApproved>()(
  "PlanApproved",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    planPath: Schema.String,
  }
) {}

export class PlanRejected extends Schema.TaggedClass<PlanRejected>()(
  "PlanRejected",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    planPath: Schema.String,
    reason: Schema.optional(Schema.String),
  }
) {}

export class CompactionStarted extends Schema.TaggedClass<CompactionStarted>()(
  "CompactionStarted",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
  }
) {}

export class CompactionCompleted
  extends Schema.TaggedClass<CompactionCompleted>()("CompactionCompleted", {
    sessionId: Schema.String,
    branchId: Schema.String,
    compactionId: Schema.String,
  }) {}

export class ErrorOccurred extends Schema.TaggedClass<ErrorOccurred>()(
  "ErrorOccurred",
  {
    sessionId: Schema.String,
    branchId: Schema.optional(Schema.String),
    error: Schema.String,
  }
) {}

export class AskUserRequested extends Schema.TaggedClass<AskUserRequested>()(
  "AskUserRequested",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    requestId: Schema.String,
    question: Schema.String,
    options: Schema.optional(Schema.Array(Schema.String)),
  }
) {}

export class AskUserResponded extends Schema.TaggedClass<AskUserResponded>()(
  "AskUserResponded",
  {
    sessionId: Schema.String,
    branchId: Schema.String,
    requestId: Schema.String,
    response: Schema.String,
  }
) {}

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
  PlanModeExited,
  PlanApproved,
  PlanRejected,
  CompactionStarted,
  CompactionCompleted,
  ErrorOccurred,
  AskUserRequested,
  AskUserResponded
)
export type AgentEvent = typeof AgentEvent.Type

// EventBus Service

export interface EventBusService {
  readonly publish: (event: AgentEvent) => Effect.Effect<void>
  readonly subscribe: () => Stream.Stream<AgentEvent>
}

export class EventBus extends Context.Tag("EventBus")<
  EventBus,
  EventBusService
>() {
  static Live: Layer.Layer<EventBus> = Layer.scoped(
    EventBus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<AgentEvent>()
      const queue = yield* PubSub.subscribe(pubsub)
      return {
        publish: (event) => PubSub.publish(pubsub, event),
        subscribe: () => Stream.fromQueue(queue),
      }
    })
  )

  static Test = (): Layer.Layer<EventBus> =>
    Layer.succeed(EventBus, {
      publish: () => Effect.void,
      subscribe: () => Stream.empty,
    })
}
