import { Context, Deferred, Effect, Layer, Queue } from "effect"
import {
  BuiltinEventSink,
  EventPublisher,
  type EventPublisherService,
} from "../domain/event-publisher.js"
import { EventStore, type EventEnvelope, type EventStoreService } from "../domain/event.js"

// ── Inner publisher logic ──

interface InnerPublisherDeps {
  readonly baseEventStore: EventStoreService
}

/**
 * Inner delivery logic. Broadcasts an already-durable event.
 */
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
    Context.add(BuiltinEventSink, {
      publish: publisher.publish,
    }),
  )

// ── Single-profile EventPublisher (ephemeral children, tests) ──

/**
 * EventPublisher appends events to the store and broadcasts committed envelopes.
 */
export const EventPublisherLive: Layer.Layer<EventPublisher | BuiltinEventSink, never, EventStore> =
  Layer.effectContext(
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
