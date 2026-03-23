import { Effect, Layer, ServiceMap, Stream } from "effect"
import { EventStore, type EventEnvelope, type EventId, EventStoreError } from "../domain/event.js"
import { Storage } from "../storage/sqlite-storage.js"
import type { SubscribeEventsInput, SubscribeLiveEventsInput } from "./transport-contract.js"

const toEventStoreError = (message: string) => (error: { readonly message: string }) =>
  new EventStoreError({ message, cause: error })

export interface SessionEventsService {
  readonly subscribeEvents: (
    input: SubscribeEventsInput,
  ) => Stream.Stream<EventEnvelope, EventStoreError>
  readonly subscribeLiveEvents: (
    input: SubscribeLiveEventsInput,
  ) => Stream.Stream<EventEnvelope, EventStoreError>
}

export class SessionEvents extends ServiceMap.Service<SessionEvents, SessionEventsService>()(
  "@gent/core/src/server/session-events/SessionEvents",
) {
  static Live = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const storage = yield* Storage
      return {
        subscribeEvents: (input) =>
          eventStore.subscribe({
            sessionId: input.sessionId,
            ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
            ...(input.after !== undefined ? { after: input.after as EventId } : {}),
          }),
        subscribeLiveEvents: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const latestId =
                (yield* storage
                  .getLatestEventId({
                    sessionId: input.sessionId,
                    ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
                  })
                  .pipe(Effect.mapError(toEventStoreError("Failed to load latest event id")))) ?? 0
              return eventStore.subscribe({
                sessionId: input.sessionId,
                ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
                after: latestId as EventId,
              })
            }),
          ),
      } satisfies SessionEventsService
    }),
  )
}
