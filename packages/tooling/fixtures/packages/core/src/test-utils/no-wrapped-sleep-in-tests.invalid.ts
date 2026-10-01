// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-wrapped-sleep-in-tests` fires 9 times. The harness
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

// Stored under a name, then waited where the name is read.
export const stored = Effect.gen(function* () {
  const pause = Effect.sleep("10 millis")
  yield* pause
})
export const mountView = Effect.gen(function* () {
  return { settle: Effect.sleep("100 millis") }
})
export const fence = Effect.sleep("5 seconds").pipe(Effect.as(-1))
export const hostFence = Bun.sleep(5)
