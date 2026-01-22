import { Effect, Layer, PubSub, Stream } from "effect"
import { EventStore, EventStoreError } from "@gent/core"
import type { EventEnvelope } from "@gent/core"
import type { StorageError } from "@gent/storage"
import { Storage } from "@gent/storage"

const toEventStoreError =
  (message: string) =>
  (error: StorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

const matchesEventFilter = (
  env: EventEnvelope,
  sessionId: string,
  branchId?: string,
): boolean => {
  if (env.event.sessionId !== sessionId) return false
  if (!branchId) return true
  const eventBranchId =
    "branchId" in env.event ? (env.event.branchId as string | undefined) : undefined
  return eventBranchId === branchId || eventBranchId === undefined
}

export const EventStoreLive: Layer.Layer<EventStore, never, Storage> = Layer.scoped(
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
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(pubsub)
            const afterId = after ?? 0
            const latestId = yield* storage
              .getLatestEventId({ sessionId, branchId })
              .pipe(Effect.mapError(toEventStoreError("Failed to load latest event id")))
            const maxId = Math.max(afterId, latestId ?? afterId)
            const buffered = yield* storage
              .listEvents({ sessionId, branchId, afterId })
              .pipe(Effect.mapError(toEventStoreError("Failed to load buffered events")))
            const initial = buffered.filter((env) => env.id <= maxId)
            const live = Stream.fromQueue(queue).pipe(
              Stream.filter(
                (env) =>
                  env.id > maxId && matchesEventFilter(env, sessionId, branchId),
              ),
            )
            return Stream.concat(Stream.fromIterable(initial), live)
          }),
        ),
    }
  }),
)
