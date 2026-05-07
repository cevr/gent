import { Clock, Context, Deferred, Effect, Layer, Queue } from "effect"
import {
  EventEnvelope,
  EventId,
  EventStore,
  ExtensionStateChanged,
  type AgentEvent,
  type EventStoreError,
  type EventStoreService,
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

interface InnerPublisherDeps {
  readonly baseEventStore: EventStoreService
}

const deliverInner = (envelope: EventEnvelope, deps: InnerPublisherDeps) =>
  deps.baseEventStore.broadcast(envelope)

const makeSerializedDeliver = (deliver: (envelope: EventEnvelope) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<DeliveryJob>()
    const delivered = new Set<EventEnvelope["id"]>()
    const maxDeliveredIds = 1024
    yield* Queue.take(queue).pipe(
      Effect.flatMap((job) =>
        Effect.gen(function* () {
          if (delivered.has(job.envelope.id)) {
            yield* Deferred.succeed(job.ack, void 0)
            return
          }
          const exit = yield* Effect.exit(deliver(job.envelope))
          if (exit._tag === "Success") {
            delivered.add(job.envelope.id)
            if (delivered.size > maxDeliveredIds) {
              const oldest = delivered.values().next().value
              if (oldest !== undefined) delivered.delete(oldest)
            }
          }
          yield* Deferred.done(job.ack, exit)
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    )

    return (envelope: EventEnvelope) =>
      Effect.gen(function* () {
        const ack = yield* Deferred.make<void>()
        yield* Queue.offer(queue, { envelope, ack })
        yield* Deferred.await(ack)
      })
  })

type DeliveryJob = {
  readonly envelope: EventEnvelope
  readonly ack: Deferred.Deferred<void>
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
    const deps: InnerPublisherDeps = { baseEventStore }
    const deliver = yield* makeSerializedDeliver((envelope) => deliverInner(envelope, deps))

    return makePublisherContext(
      EventPublisher.of({
        append: (event) => baseEventStore.append(event),
        deliver,
        publish: (event) =>
          Effect.gen(function* () {
            const envelope = yield* baseEventStore.append(event)
            yield* deliver(envelope)
          }),
      }),
    )
  }),
)
