import { Deferred, Effect } from "effect"

export const waitDeferred = Deferred.await

export const sleepMillis = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`)

export const fromPromise = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.promise(evaluate)

export const raceWithNullTimeout = <A>(
  promise: PromiseLike<A>,
  timeoutMs: number,
): Effect.Effect<A | null> =>
  Effect.race(
    Effect.promise(() => promise),
    sleepMillis(timeoutMs).pipe(Effect.as(null)),
  )

export const ignoreSyncDefect = (evaluate: () => void): Effect.Effect<void> =>
  Effect.sync(evaluate).pipe(Effect.catchCause(() => Effect.void))
