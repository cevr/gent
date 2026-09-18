import { Effect, Layer, Option, Predicate } from "effect"
import { EventStore, EventStoreError, makeEventStore } from "../domain/event.js"
import { EventStorage, type EventStorageError, SessionStorage } from "../storage/storage.js"
import { omitUndefined } from "../domain/guards.js"

const toEventStoreError =
  (message: string) =>
  (error: EventStorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

export const EventStoreLive: Layer.Layer<EventStore, never, EventStorage | SessionStorage> =
  Layer.unwrap(
    Effect.gen(function* () {
      const eventStorage = yield* EventStorage
      const sessionStorage = yield* SessionStorage
      const service = yield* makeEventStore({
        append: (event, traceId) =>
          eventStorage
            .appendEvent(event, omitUndefined({ traceId: Option.getOrUndefined(traceId) }))
            .pipe(Effect.mapError(toEventStoreError("Failed to append event"))),
        load: (sessionId, afterId) =>
          eventStorage
            .listEvents({ sessionId, afterId })
            .pipe(Effect.mapError(toEventStoreError("Failed to load session events"))),
        open: ({ sessionId, branchId, after }) =>
          Effect.gen(function* () {
            const session = yield* sessionStorage
              .getSession(sessionId)
              .pipe(Effect.mapError(toEventStoreError("Failed to validate session")))
            if (Predicate.isUndefined(session)) {
              return yield* new EventStoreError({ message: `Session not found: ${sessionId}` })
            }
            yield* Effect.logInfo("EventStore.subscribe.open").pipe(
              Effect.annotateLogs({ sessionId, branchId: branchId ?? "all", afterId: after ?? 0 }),
            )
            yield* Effect.addFinalizer(() =>
              Effect.logInfo("EventStore.subscribe.close").pipe(
                Effect.annotateLogs({ sessionId, branchId: branchId ?? "all" }),
              ),
            )
          }),
      })
      return Layer.succeed(EventStore, service)
    }),
  )
