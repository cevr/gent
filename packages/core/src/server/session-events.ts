import { Effect, Layer, ServiceMap } from "effect"
import type { Stream } from "effect"
import {
  EventStore,
  type EventEnvelope,
  type EventId,
  type EventStoreError,
} from "../domain/event.js"
import type { SubscribeEventsInput } from "./transport-contract.js"

export interface SessionEventsService {
  readonly subscribeEvents: (
    input: SubscribeEventsInput,
  ) => Stream.Stream<EventEnvelope, EventStoreError>
}

export class SessionEvents extends ServiceMap.Service<SessionEvents, SessionEventsService>()(
  "@gent/core/src/server/session-events/SessionEvents",
) {
  static Live = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      return {
        subscribeEvents: (input) =>
          eventStore.subscribe({
            sessionId: input.sessionId,
            ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
            ...(input.after !== undefined ? { after: input.after as EventId } : {}),
          }),
      } satisfies SessionEventsService
    }),
  )
}
