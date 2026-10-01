// @ts-nocheck — held-shapes fixture
// Test code. Retired with oxlint-plugin-effect 0.18 (01c98e897):
// no-promise-control-flow-in-tests, no-die-in-test-helpers, no-inert-it,
// no-sleep.
import { test } from "bun:test"
import { Duration, Effect } from "effect"
import { describe, expect, it } from "effect-bun-test"

declare const work: () => Promise<string>
declare const cleanup: () => void

test("promise chains", () => work().then((value) => value)) // held-by: effect/noPromiseChainsInTests
test("promise catch", () => work().catch(() => "fallback")) // held-by: effect/noPromiseChainsInTests
test("promise finally", () => work().finally(cleanup)) // held-by: effect/noPromiseChainsInTests
test("runPromise", () => Effect.runPromise(Effect.succeed("work"))) // held-by: effect/noEffectRunInTests

export const timedOut = () => Effect.die(new Error("Timed out waiting for state")) // held-by: effect/noTimeoutDieInTests
export const withMessage = () => Effect.dieMessage("timeout waiting for state") // held-by: effect/noTimeoutDieInTests

describe("inert forms", () => {
  it("arrow body", () => { // held-by: effect/noEffectBunTestItCall
    expect(1).toBe(2)
  })
})

export const zeroMillis = Effect.sleep("0 millis") // held-by: effect/noFixedWaitInTests
export const durationMillis = Effect.sleep(Duration.millis(100)) // held-by: effect/noFixedWaitInTests
export const bunSleepZero = Bun.sleep(0) // held-by: effect/noFixedWaitInTests
