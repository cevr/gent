import { Clock, Context, Effect, Layer } from "effect"
import {
  EventEnvelope,
  EventId,
  EventStore,
  ExtensionStateChanged,
  type AgentEvent,
  type EventStoreError,
} from "./event.js"
import type { BranchId, ExtensionId, SessionId } from "./ids.js"

export interface EventPublisherService {
  readonly append: (event: AgentEvent) => Effect.Effect<EventEnvelope, EventStoreError>
  readonly deliver: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
}

export interface ExtensionEventSinkService {
  readonly publish: (event: AgentEvent) => Effect.Effect<void, EventStoreError>
}

export interface ExtensionStatePublisherService {
  readonly changed: (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly extensionId: ExtensionId
  }) => Effect.Effect<void, EventStoreError>
}

export class EventPublisher extends Context.Service<EventPublisher, EventPublisherService>()(
  "@gent/core/src/domain/event-publisher/EventPublisher",
) {
  static Test = (): Layer.Layer<EventPublisher> =>
    Layer.succeed(EventPublisher, {
      append: (event) =>
        Effect.map(Clock.currentTimeMillis, (createdAt) =>
          EventEnvelope.make({ id: EventId.make(0), event, createdAt }),
        ),
      deliver: () => Effect.void,
      publish: () => Effect.void,
    })
}

export class ExtensionEventSink extends Context.Service<
  ExtensionEventSink,
  ExtensionEventSinkService
>()("@gent/core/src/domain/event-publisher/ExtensionEventSink") {
  static Test = (): Layer.Layer<ExtensionEventSink> =>
    Layer.succeed(ExtensionEventSink, {
      publish: () => Effect.void,
    })
}

export class ExtensionStatePublisher extends Context.Service<
  ExtensionStatePublisher,
  ExtensionStatePublisherService
>()("@gent/core/src/domain/event-publisher/ExtensionStatePublisher") {
  static Test = (): Layer.Layer<ExtensionStatePublisher> =>
    Layer.succeed(ExtensionStatePublisher, {
      changed: () => Effect.void,
    })
}

const makePublisherContext = (publisher: EventPublisherService) =>
  Context.empty().pipe(
    Context.add(EventPublisher, publisher),
    Context.add(ExtensionEventSink, {
      publish: publisher.publish,
    }),
    Context.add(ExtensionStatePublisher, {
      changed: (params) => publisher.publish(ExtensionStateChanged.make(params)),
    }),
  )

export const EventPublisherLive: Layer.Layer<
  EventPublisher | ExtensionEventSink | ExtensionStatePublisher,
  never,
  EventStore
> = Layer.effectContext(
  Effect.gen(function* () {
    const baseEventStore = yield* EventStore

    return makePublisherContext(
      EventPublisher.of({
        append: (event) => baseEventStore.append(event),
        deliver: (envelope) => baseEventStore.deliver(envelope),
        publish: (event) =>
          Effect.gen(function* () {
            const envelope = yield* baseEventStore.append(event)
            yield* baseEventStore.deliver(envelope)
          }),
      }),
    )
  }),
)
