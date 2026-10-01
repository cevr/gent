// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-wrapped-sleep-in-tests` fires 5 times. The harness
// is test code, and upstream reports a sleep only when a statement waits on
// the sleep alone.
import { Clock, Effect } from "effect"

declare const wallClock: Clock.Clock
declare const settled: Effect.Effect<void>

export const poll = Effect.gen(function* () {
  // Piped, raced, sequenced, and bound: each waits on the sleep.
  yield* Effect.sleep("2 millis").pipe(Effect.provideService(Clock.Clock, wallClock))
  yield* settled.pipe(Effect.raceFirst(Effect.sleep("300 millis")))
  yield* Effect.andThen(Effect.sleep("10 millis"), settled)
  const bound = yield* Effect.sleep("10 millis")
  return bound
})

export const host = async () => {
  await Promise.race([Bun.sleep(10), Promise.resolve()])
}
