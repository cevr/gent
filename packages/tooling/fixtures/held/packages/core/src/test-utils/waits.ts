// @ts-nocheck — held-shapes fixture
// The harness is test code. Retired: no-sleep (01c98e897),
// no-wrapped-sleep-in-tests (4a949ff7c), no-runtime-run-promise-in-tests
// (3850ccea3), no-timeout-die-payload-in-tests (be6722a93).
import { Clock, Effect, Schema } from "effect"

declare const wallClock: Clock.Clock
declare const settled: Effect.Effect<void>
declare const runtime: { runPromise: (effect: Effect.Effect<string>) => Promise<string> }
declare const ui: {
  clientRuntime: { runPromiseExit: (effect: Effect.Effect<string>) => Promise<string> }
}

class WaitForError extends Schema.TaggedError<WaitForError>()("WaitForError", {
  message: Schema.String,
}) {}

export const settle = Effect.sleep("20 millis") // held-by: effect/noFixedWaitInTests
export const poll = Effect.gen(function* () {
  yield* Effect.sleep("2 millis").pipe(Effect.provideService(Clock.Clock, wallClock)) // held-by: effect/noFixedWaitInTests
  yield* settled.pipe(Effect.raceFirst(Effect.sleep("300 millis"))) // held-by: effect/noFixedWaitInTests
  yield* Effect.andThen(Effect.sleep("10 millis"), settled) // held-by: effect/noFixedWaitInTests
  const pause = Effect.sleep("10 millis") // held-by: effect/noFixedWaitInTests
  yield* pause
})
export const fence = Effect.sleep("5 seconds").pipe(Effect.as(-1)) // held-by: effect/noFixedWaitInTests
export const hostFence = Bun.sleep(5) // held-by: effect/noFixedWaitInTests

export const direct = runtime.runPromise(Effect.succeed("work")) // held-by: effect/noEffectRunInTests
export const nested = ui.clientRuntime.runPromiseExit(Effect.succeed("work")) // held-by: effect/noEffectRunInTests

export const typedPayload = Effect.die(new WaitForError({ message: "timed out waiting" })) // held-by: effect/noTimeoutDieInTests
export const plainPayload = Effect.die({ reason: "gave up on the socket" }) // held-by: effect/noTimeoutDieInTests
export const nestedPayload = Effect.die(new Error("stuck", { cause: { why: `timeout` } })) // held-by: effect/noTimeoutDieInTests
