import { Effect, Layer, PubSub, Stream } from "effect"
import {
  EventStore,
  EventStoreError,
  matchesBranchFilter,
  makeSerializedEventDelivery,
} from "../domain/event.js"
import type { EventStoreService } from "../domain/event.js"
import type { StorageError } from "../domain/storage-error.js"
import { EventStorage } from "../storage/event-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { makeSessionPubSubRegistry } from "./session-pubsub-registry.js"

const toEventStoreError =
  (message: string) =>
  (error: StorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

export const EventStoreLive: Layer.Layer<EventStore, never, EventStorage | SessionStorage> =
  Layer.unwrap(
    Effect.gen(function* () {
      const eventStorage = yield* EventStorage
      const sessionStorage = yield* SessionStorage
      const registry = makeSessionPubSubRegistry()

      const deliver = yield* makeSerializedEventDelivery(registry.broadcast)

      const service: EventStoreService = {
        append: Effect.fn("EventStore.append")(function* (event) {
          const currentSpan = yield* Effect.currentParentSpan.pipe(
            Effect.orElseSucceed(() => undefined),
          )
          const traceId = currentSpan !== undefined ? currentSpan.traceId : undefined
          const envelope = yield* eventStorage
            .appendEvent(event, traceId !== undefined ? { traceId } : undefined)
            .pipe(Effect.mapError(toEventStoreError("Failed to append event")))
          return envelope
        }),

        broadcast: registry.broadcast,
        deliver,

        publish: Effect.fn("EventStore.publish")(function* (event) {
          const envelope = yield* service.append(event)
          yield* deliver(envelope)
        }),

        subscribe: ({ sessionId, branchId, after }) =>
          Stream.scoped(
            Stream.unwrap(
              Effect.gen(function* () {
                const afterId = after ?? 0
                const session = yield* sessionStorage
                  .getSession(sessionId)
                  .pipe(Effect.mapError(toEventStoreError("Failed to validate session")))
                if (session === undefined) {
                  return yield* new EventStoreError({
                    message: `Session not found: ${sessionId}`,
                  })
                }
                const ps = yield* registry.getOrCreate(sessionId)
                const subscription = yield* PubSub.subscribe(ps)
                const initial = yield* eventStorage
                  .listEvents({ sessionId, branchId, afterId })
                  .pipe(Effect.mapError(toEventStoreError("Failed to load buffered events")))
                const maxId = initial[initial.length - 1]?.id ?? afterId
                const live = Stream.fromSubscription(subscription).pipe(
                  Stream.filter((env) => env.id > maxId && matchesBranchFilter(env, branchId)),
                )

                yield* Effect.logInfo("EventStore.subscribe.open").pipe(
                  Effect.annotateLogs({
                    sessionId,
                    branchId: branchId ?? "all",
                    afterId,
                    initialCount: initial.length,
                  }),
                )
                yield* Effect.addFinalizer(() =>
                  Effect.logInfo("EventStore.subscribe.close").pipe(
                    Effect.annotateLogs({ sessionId, branchId: branchId ?? "all" }),
                  ),
                )

                return Stream.concat(Stream.fromIterable(initial), live)
              }),
            ),
          ),

        removeSession: registry.remove,
      }

      return Layer.succeed(EventStore, service)
    }),
  )
