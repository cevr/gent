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
        const envelope = yield* storage
          .appendEvent(event)
          .pipe(Effect.mapError(toEventStoreError("Failed to append event")))
        yield* PubSub.publish(pubsub, envelope)
      }),

      subscribe: ({ sessionId, branchId, after }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const afterId = after ?? 0
            const latestId = yield* storage
              .getLatestEventId({ sessionId, branchId })
              .pipe(Effect.mapError(toEventStoreError("Failed to load latest event id")))
            const maxId = Math.max(afterId, latestId ?? afterId)
            const buffered = yield* storage
              .listEvents({ sessionId, branchId, afterId })
              .pipe(Effect.mapError(toEventStoreError("Failed to load buffered events")))
            const initial = buffered.filter((env: EventEnvelope) => env.id <= maxId)
            const live = Stream.fromPubSub(pubsub).pipe(
              Stream.filter(
                (env: EventEnvelope) =>
                  env.id > maxId && matchesEventFilter(env, sessionId, branchId),
              ),
            )
            return Stream.concat(Stream.fromIterable(initial), live)
          }),
        ),
    }
  }),
)
