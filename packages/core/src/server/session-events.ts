import { Effect, Layer, ServiceMap, Stream } from "effect"
import {
  EventStore,
  type EventEnvelope,
  type EventId,
  type EventStoreError,
} from "../domain/event.js"
import type { SubscribeEventsInput } from "./transport-contract.js"

const isPublicTransportEvent = (envelope: EventEnvelope) =>
  envelope.event._tag !== "MachineInspected" &&
  envelope.event._tag !== "MachineTaskSucceeded" &&
  envelope.event._tag !== "MachineTaskFailed"

export interface SessionEventsService {
  readonly streamEvents: (
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
        streamEvents: (input) =>
          eventStore
            .subscribe({
              sessionId: input.sessionId,
              ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
              ...(input.after !== undefined ? { after: input.after as EventId } : {}),
            })
            .pipe(Stream.filter(isPublicTransportEvent)),
      } satisfies SessionEventsService
    }),
  )
}
