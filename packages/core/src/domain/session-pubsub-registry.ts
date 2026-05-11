import { Effect, HashMap, PubSub, type Scope, TxRef } from "effect"
import type { EventEnvelope } from "./event.js"
import { getEventSessionId } from "./event.js"
import type { SessionId } from "./ids.js"

/**
 * Per-session PubSub registry. Both the in-memory and durable
 * EventStore implementations need the same coordination primitive:
 * lazily create a `PubSub<EventEnvelope>` per session, broadcast
 * envelopes to the matching session's PubSub, and shut a session's
 * PubSub down on removal. Hand-rolled in two places before this
 * extraction; drift between the copies is a latent correctness
 * hazard.
 *
 * `subscribe` returns a scoped subscription queue rather than
 * exposing the raw PubSub. Callers open the subscription before
 * loading the backlog so live events aren't dropped during the
 * race between historical-load and live-tail.
 */
export interface SessionPubSubRegistry {
  readonly subscribe: (
    sessionId: SessionId,
  ) => Effect.Effect<PubSub.Subscription<EventEnvelope>, never, Scope.Scope>
  readonly broadcast: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly remove: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeSessionPubSubRegistry: Effect.Effect<SessionPubSubRegistry> = Effect.gen(
  function* () {
    const sessionsRef = yield* TxRef.make(HashMap.empty<SessionId, PubSub.PubSub<EventEnvelope>>())

    const getOrCreate = (sessionId: SessionId): Effect.Effect<PubSub.PubSub<EventEnvelope>> =>
      Effect.gen(function* () {
        const existing = HashMap.get(yield* TxRef.get(sessionsRef), sessionId)
        if (existing._tag === "Some") return existing.value
        const fresh = yield* PubSub.unbounded<EventEnvelope>()
        // Race-safe install: re-check, install only if still missing.
        return yield* TxRef.modify(sessionsRef, (current) => {
          const found = HashMap.get(current, sessionId)
          if (found._tag === "Some") return [found.value, current]
          return [fresh, HashMap.set(current, sessionId, fresh)]
        })
      })

    const subscribe = (
      sessionId: SessionId,
    ): Effect.Effect<PubSub.Subscription<EventEnvelope>, never, Scope.Scope> =>
      Effect.gen(function* () {
        const ps = yield* getOrCreate(sessionId)
        return yield* PubSub.subscribe(ps)
      })

    const broadcast = (envelope: EventEnvelope): Effect.Effect<void> => {
      const eventSessionId = getEventSessionId(envelope.event)
      if (eventSessionId === undefined) return Effect.void
      return Effect.gen(function* () {
        const ps = yield* getOrCreate(eventSessionId)
        yield* PubSub.publish(ps, envelope)
      })
    }

    const remove = (sessionId: SessionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const removed = yield* TxRef.modify(sessionsRef, (current) => {
          const found = HashMap.get(current, sessionId)
          if (found._tag === "None") return [undefined, current]
          return [found.value, HashMap.remove(current, sessionId)] as const
        })
        if (removed !== undefined) yield* PubSub.shutdown(removed)
      })

    return { subscribe, broadcast, remove }
  },
)
