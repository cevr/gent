import { Effect, Layer, PubSub, Stream } from "effect"
import { EventStore, EventStoreError, matchesEventFilter } from "../domain/event.js"
import type { EventEnvelope } from "../domain/event.js"
import { Storage, type StorageError } from "../storage/sqlite-storage.js"

const toEventStoreError =
  (message: string) =>
  (error: StorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

export const EventStoreLive: Layer.Layer<EventStore, never, Storage> = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const storage = yield* Storage
    const pubsub = yield* PubSub.unbounded<EventEnvelope>()

    return {
      publish: Effect.fn("EventStore.publish")(function* (event) {
        const currentSpan = yield* Effect.currentParentSpan.pipe(
          Effect.orElseSucceed(() => undefined),
        )
        const traceId = currentSpan !== undefined ? currentSpan.traceId : undefined
        const envelope = yield* storage
          .appendEvent(event, traceId !== undefined ? { traceId } : undefined)
          .pipe(Effect.mapError(toEventStoreError("Failed to append event")))
        yield* PubSub.publish(pubsub, envelope)
      }),

      subscribe: ({ sessionId, branchId, after }) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              const afterId = after ?? 0
              const subscription = yield* PubSub.subscribe(pubsub)
              const initial = yield* storage
                .listEvents({ sessionId, branchId, afterId })
                .pipe(Effect.mapError(toEventStoreError("Failed to load buffered events")))
              const maxId = initial[initial.length - 1]?.id ?? afterId
              const live = Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (env) => env.id > maxId && matchesEventFilter(env, sessionId, branchId),
                ),
              )

              return Stream.concat(Stream.fromIterable(initial), live)
            }),
          ),
        ),
    }
  }),
)
