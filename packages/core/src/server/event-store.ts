import { Effect, Layer, Option, Stream } from "effect"
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

    return {
      publish: Effect.fn("EventStore.publish")(function* (event) {
        const currentSpan = yield* Effect.currentParentSpan.pipe(
          Effect.orElseSucceed(() => undefined),
        )
        const traceId = currentSpan !== undefined ? currentSpan.traceId : undefined
        yield* storage
          .appendEvent(event, traceId !== undefined ? { traceId } : undefined)
          .pipe(Effect.mapError(toEventStoreError("Failed to append event")))
      }),

      subscribe: ({ sessionId, branchId, after }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const afterId = after ?? 0
            const pollSince = (lastSeenId: number): Stream.Stream<EventEnvelope, EventStoreError> =>
              Stream.paginate(lastSeenId, (cursor) =>
                storage.listEvents({ sessionId, branchId, afterId: cursor }).pipe(
                  Effect.mapError(toEventStoreError("Failed to load live events")),
                  Effect.flatMap((events) =>
                    Effect.sleep("100 millis").pipe(
                      Effect.as([
                        events.filter((env: EventEnvelope) =>
                          matchesEventFilter(env, sessionId, branchId),
                        ),
                        Option.some(events[events.length - 1]?.id ?? cursor),
                      ] as const),
                    ),
                  ),
                ),
              )

            const initial = yield* storage
              .listEvents({ sessionId, branchId, afterId })
              .pipe(Effect.mapError(toEventStoreError("Failed to load buffered events")))
            const maxId = initial[initial.length - 1]?.id ?? afterId

            return Stream.concat(Stream.fromIterable(initial), pollSince(maxId))
          }),
        ),
    }
  }),
)
