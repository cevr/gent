import {
  Clock,
  Effect,
  HashMap,
  Option,
  Predicate,
  PubSub,
  type Scope,
  Stream,
  TxRef,
} from "effect"
import type { EventId } from "./event.js"
import {
  EventEnvelope,
  getEventSessionId,
  matchesBranchFilter,
  StreamSynchronized,
} from "./event.js"
import type { BranchId, SessionId } from "./ids.js"

/**
 * Slow-client policy: bounded notification plus durable cursor replay.
 *
 * Each session owns one sliding PubSub of event ids. A publisher never waits
 * for subscribers, so a stalled client cannot block tool execution. A
 * subscriber that falls behind loses only notifications, never events: every
 * wake-up drains the durable store from the subscriber's own cursor, and the
 * newest notification always survives eviction, so a subscriber that missed
 * some notifications still drains once more.
 */
export const SESSION_NOTIFICATION_CAPACITY = 64

export interface SessionPubSubRegistry {
  readonly subscribe: (
    sessionId: SessionId,
  ) => Effect.Effect<PubSub.Subscription<EventId>, never, Scope.Scope>
  readonly broadcast: (envelope: EventEnvelope) => Effect.Effect<void>
  readonly remove: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeSessionPubSubRegistry: Effect.Effect<SessionPubSubRegistry> = Effect.gen(
  function* () {
    const sessionsRef = yield* TxRef.make(HashMap.empty<SessionId, PubSub.PubSub<EventId>>())

    const getOrCreate = (sessionId: SessionId): Effect.Effect<PubSub.PubSub<EventId>> =>
      Effect.gen(function* () {
        const existing = HashMap.get(yield* TxRef.get(sessionsRef), sessionId)
        if (existing._tag === "Some") return existing.value
        const fresh = yield* PubSub.sliding<EventId>(SESSION_NOTIFICATION_CAPACITY)
        // Race-safe install: re-check, install only if still missing.
        return yield* TxRef.modify(sessionsRef, (current) => {
          const found = HashMap.get(current, sessionId)
          if (found._tag === "Some") return [found.value, current]
          return [fresh, HashMap.set(current, sessionId, fresh)]
        })
      })

    const subscribe = (
      sessionId: SessionId,
    ): Effect.Effect<PubSub.Subscription<EventId>, never, Scope.Scope> =>
      Effect.gen(function* () {
        const ps = yield* getOrCreate(sessionId)
        return yield* PubSub.subscribe(ps)
      })

    const broadcast = (envelope: EventEnvelope): Effect.Effect<void> => {
      const eventSessionId = getEventSessionId(envelope.event)
      return Effect.gen(function* () {
        const ps = yield* getOrCreate(eventSessionId)
        yield* PubSub.publish(ps, envelope.id)
      })
    }

    const remove = (sessionId: SessionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const removed = yield* TxRef.modify(sessionsRef, (current) => {
          const found = HashMap.get(current, sessionId)
          if (found._tag === "None") return [Option.none<PubSub.PubSub<EventId>>(), current]
          return [Option.some(found.value), HashMap.remove(current, sessionId)]
        })
        if (Option.isSome(removed)) yield* PubSub.shutdown(removed.value)
      })

    return { subscribe, broadcast, remove }
  },
)

/**
 * One ordered event stream from a durable cursor. The caller opens the
 * subscription before calling this, so an append during the first drain
 * leaves a notification behind and is drained next. Every drain reads the
 * session's events after the cursor, so notifications may be lost or
 * coalesced without losing or repeating events.
 */
export const makeCursorReplayStream = <E>(params: {
  readonly subscription: PubSub.Subscription<EventId>
  readonly sessionId: SessionId
  readonly afterId: EventId
  readonly branchId?: BranchId
  /**
   * Emit one `StreamSynchronized` envelope after the replay and before live
   * delivery. Its id is the replay cursor, so a client resuming from the last
   * seen id neither skips nor repeats an event. Transport subscriptions ask for
   * it; in-process consumers that only await specific events do not.
   */
  readonly synchronize?: boolean
  /** Session events with id greater than the cursor, ascending. */
  readonly load: (afterId: EventId) => Effect.Effect<ReadonlyArray<EventEnvelope>, E>
}): Stream.Stream<EventEnvelope, E> =>
  Stream.unwrap(
    Effect.gen(function* () {
      let cursor = params.afterId
      const drain = Effect.gen(function* () {
        const batch = yield* params.load(cursor)
        const last = batch[batch.length - 1]
        if (Predicate.isNotUndefined(last)) cursor = last.id
        return batch.filter((env) => matchesBranchFilter(env, params.branchId))
      })
      const initial = yield* drain
      const marker = Effect.gen(function* () {
        if (params.synchronize !== true) return []
        const envelope = EventEnvelope.make({
          id: cursor,
          event: StreamSynchronized.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            lastEventId: cursor,
          }),
          createdAt: yield* Clock.currentTimeMillis,
        })
        return [envelope]
      })
      const live = Stream.fromSubscription(params.subscription).pipe(
        // One durable read per burst of notifications.
        Stream.chunks,
        Stream.mapEffect(() => drain),
        Stream.flatMap(Stream.fromIterable),
      )
      return Stream.concat(
        Stream.fromIterable(initial),
        Stream.concat(Stream.fromIterable(yield* marker), live),
      )
    }),
  )
