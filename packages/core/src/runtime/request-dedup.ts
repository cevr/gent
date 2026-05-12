import { Cache, Duration, Effect, Exit, Ref } from "effect"

// Dedup cache: bound success entries by both time and count so a
// long-running shared server does not accumulate one entry per user
// prompt + per session create indefinitely.
const DEDUP_SUCCESS_TTL: Duration.Input = Duration.seconds(60)
const DEDUP_MAX_ENTRIES = 1024

/**
 * Atomic-claim dedup helper backed by `Cache.makeWith`. Concurrent callers
 * with the same `requestId` collapse onto a single body execution via the
 * Cache's internal `Deferred`.
 *
 * Eviction:
 * - On failure: `timeToLive: Duration.zero` removes the entry immediately so
 *   retries can re-attempt the same `requestId` under fresh state
 *   (Cache.ts:707-710).
 * - On success: TTL window keeps the result available for retries
 *   (Cache.ts:705-708).
 * - Hard cap (LRU): `Cache` re-inserts on read (Cache.ts:524-526) and evicts
 *   the oldest-touched entry past `capacity` (Cache.ts:724-733). Under the
 *   retry-heavy workload this dedup serves, LRU is safe: a fresh same-key
 *   retry observes a still-fresh cache entry; an unrelated stale entry is the
 *   one evicted to make room.
 */
export interface RequestDeduper<In, A, E> {
  (input: In): Effect.Effect<A, E>
  readonly invalidate: (input: In) => Effect.Effect<void>
  readonly invalidateKey: (key: string) => Effect.Effect<void>
}

export const makeRequestDeduper = <In, A, E>(opts: {
  readonly body: (input: In) => Effect.Effect<A, E>
  readonly keyOf: (input: In) => string | undefined
  readonly maxEntries?: number
  readonly successTtl?: Duration.Input
}): Effect.Effect<RequestDeduper<In, A, E>> =>
  Effect.gen(function* () {
    // Body bridge: `Cache.lookup` takes only the key, but each call has a
    // distinct body Effect. Pending stores the body keyed by `requestId`; the
    // running lookup pulls it out on miss. Every caller registers its body
    // and removes it on exit via `Effect.ensuring`, which keeps `pending`
    // free of stale-body leaks under interruption and same-key races.
    const pending = yield* Ref.make(new Map<string, Effect.Effect<A, E>>())
    const successTtl = Duration.fromInputUnsafe(opts.successTtl ?? DEDUP_SUCCESS_TTL)
    const cache = yield* Cache.makeWith<string, A, E>(
      (key) =>
        Effect.gen(function* () {
          const body = (yield* Ref.get(pending)).get(key)
          return yield* body ?? Effect.die("makeRequestDeduper: missing pending body")
        }),
      {
        capacity: opts.maxEntries ?? DEDUP_MAX_ENTRIES,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? successTtl : Duration.zero),
      },
    )
    const invalidateKey = (key: string) => Cache.invalidate(cache, key)
    const invalidate = (input: In) => {
      const key = opts.keyOf(input)
      return key === undefined ? Effect.void : invalidateKey(key)
    }
    const run = (input: In) => {
      const key = opts.keyOf(input)
      if (key === undefined) return opts.body(input)
      const body = opts.body(input)
      const remove = Ref.update(pending, (m) => {
        // Only delete if we are still the registered body — a later caller
        // may have already overwritten us, in which case our entry is gone
        // (or about to be removed by that caller's `ensuring`).
        if (m.get(key) !== body) return m
        const next = new Map(m)
        next.delete(key)
        return next
      })
      return Effect.gen(function* () {
        // Always overwrite: same-key concurrent fibers all register their
        // bodies; whichever wins the lookup race determines the outcome that
        // every caller awaits via `Cache.get`. The `requestId` dedup contract
        // assumes idempotency, so any caller's body produces the same result.
        yield* Ref.update(pending, (m) => {
          const next = new Map(m)
          next.set(key, body)
          return next
        })
        return yield* Cache.get(cache, key)
      }).pipe(Effect.ensuring(remove))
    }
    return Object.assign(run, { invalidate, invalidateKey }) satisfies RequestDeduper<In, A, E>
  })
