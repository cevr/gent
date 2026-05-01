import { Effect, Layer, Context } from "effect"
import { EventEnvelope, EventId, type AgentEvent, type EventStoreError } from "./event.js"

export interface EventPublisherService {
  readonly append: (event: AgentEvent) => Effect.Effect<EventEnvelope, EventStoreError>
  readonly deliver: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
}

export interface BuiltinEventSinkService {
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
}

export class EventPublisher extends Context.Service<EventPublisher, EventPublisherService>()(
  "@gent/core/src/domain/event-publisher/EventPublisher",
) {
  static Test = (): Layer.Layer<EventPublisher> =>
    Layer.succeed(EventPublisher, {
      append: (event) =>
        Effect.succeed(EventEnvelope.make({ id: EventId.make(0), event, createdAt: Date.now() })),
      deliver: () => Effect.void,
      publish: () => Effect.void,
    })
}

export class BuiltinEventSink extends Context.Service<BuiltinEventSink, BuiltinEventSinkService>()(
  "@gent/core/src/domain/event-publisher/BuiltinEventSink",
) {
  static Test = (): Layer.Layer<BuiltinEventSink> =>
    Layer.succeed(BuiltinEventSink, {
      publish: () => Effect.void,
    })
}
