import { Effect, Layer, ServiceMap } from "effect"
import type { SessionId } from "./ids.js"
import type { AgentEvent, EventStoreError } from "./event.js"

export interface EventPublisherService {
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void>
}

export class EventPublisher extends ServiceMap.Service<EventPublisher, EventPublisherService>()(
  "@gent/core/src/domain/event-publisher/EventPublisher",
) {
  static Test = (): Layer.Layer<EventPublisher> =>
    Layer.succeed(EventPublisher, {
      publish: () => Effect.void,
      terminateSession: () => Effect.void,
    })
}
