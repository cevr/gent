import { Effect, PubSub } from "effect"
import type { EventEnvelope } from "../domain/event.js"
import { getEventSessionId } from "../domain/event.js"
import type { SessionId } from "../domain/ids.js"

/**
 * Per-session PubSub registry. Both the in-memory and durable
 * EventStore implementations need the same coordination primitive:
 * lazily create a `PubSub<EventEnvelope>` per session, broadcast
 * envelopes to the matching session's PubSub, and shut a session's
 * PubSub down on removal. Hand-rolled in two places before this
 * extraction; drift between the copies is a latent correctness
 * hazard.
 */
export interface SessionPubSubRegistry {
  readonly getOrCreate: (sessionId: SessionId) => Effect.Effect<PubSub.PubSub<EventEnvelope>>
  readonly broadcast: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly remove: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeSessionPubSubRegistry = (): SessionPubSubRegistry => {
  const sessions = new Map<SessionId, PubSub.PubSub<EventEnvelope>>()

  const getOrCreate = (sessionId: SessionId): Effect.Effect<PubSub.PubSub<EventEnvelope>> =>
    Effect.gen(function* () {
      const existing = sessions.get(sessionId)
      if (existing !== undefined) return existing
      const ps = yield* PubSub.unbounded<EventEnvelope>()
      sessions.set(sessionId, ps)
      return ps
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
      const ps = sessions.get(sessionId)
      if (ps !== undefined) {
        sessions.delete(sessionId)
        yield* PubSub.shutdown(ps)
      }
    })

  return { getOrCreate, broadcast, remove }
}
