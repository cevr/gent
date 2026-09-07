import { Effect, Layer, Option, Predicate, Stream } from "effect"
import {
  EventId,
  EventStore,
  EventStoreError,
  makeSerializedEventDelivery,
} from "../domain/event.js"
import type { EventStoreService } from "../domain/event.js"
import {
  makeCursorReplayStream,
  makeSessionPubSubRegistry,
} from "../domain/session-pubsub-registry.js"
import { EventStorage, type EventStorageError } from "../storage/event-storage.js"
import { SessionStorage } from "../storage/session-storage.js"

const toEventStoreError =
  (message: string) =>
  (error: EventStorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

export const EventStoreLive: Layer.Layer<EventStore, never, EventStorage | SessionStorage> =
  Layer.unwrap(
    Effect.gen(function* () {
      const eventStorage = yield* EventStorage
      const sessionStorage = yield* SessionStorage
      const registry = yield* makeSessionPubSubRegistry

      const deliver = yield* makeSerializedEventDelivery(registry.broadcast)

      const service: EventStoreService = {
        append: Effect.fn("EventStore.append")(function* (event) {
          const currentSpan = yield* Effect.currentParentSpan.pipe(Effect.option)
          const appendOptions = Option.match(currentSpan, {
            onNone: () => ({}),
            onSome: (span) => ({ traceId: span.traceId }),
          })
          const envelope = yield* eventStorage
            .appendEvent(event, appendOptions)
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
                if (Predicate.isUndefined(session)) {
                  return yield* new EventStoreError({
                    message: `Session not found: ${sessionId}`,
                  })
                }
                const subscription = yield* registry.subscribe(sessionId)

                yield* Effect.logInfo("EventStore.subscribe.open").pipe(
                  Effect.annotateLogs({ sessionId, branchId: branchId ?? "all", afterId }),
                )
                yield* Effect.addFinalizer(() =>
                  Effect.logInfo("EventStore.subscribe.close").pipe(
                    Effect.annotateLogs({ sessionId, branchId: branchId ?? "all" }),
                  ),
                )

                return makeCursorReplayStream({
                  subscription,
                  afterId: EventId.make(afterId),
                  branchId,
                  load: (cursor) =>
                    eventStorage
                      .listEvents({ sessionId, afterId: cursor })
                      .pipe(Effect.mapError(toEventStoreError("Failed to load session events"))),
                })
              }),
            ),
          ),

        removeSession: registry.remove,
      }

      return Layer.succeed(EventStore, service)
    }),
  )
