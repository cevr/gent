// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-wrapped-sleep-in-tests` does NOT fire. A statement
// that waits on a sleep alone is upstream `effect/noFixedWaitInTests`'s case,
// and a sleep a function builds is the caller's to wait on or not.
import { Effect } from "effect"

declare const runWith: (driver: { read: () => Effect.Effect<string> }) => Effect.Effect<string>

export const upstreamCase = Effect.gen(function* () {
  yield* Effect.sleep("10 millis")
})

// The subject's own delay, handed to a mock as a value, inside a waited call.
export const slowRead = Effect.gen(function* () {
  return yield* runWith({ read: () => Effect.sleep("120 millis").pipe(Effect.as("data")) })
})
export const delayed = (ms: number) => Effect.sleep(ms)
