// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-die-in-test-helpers` fires for `Effect.die` /
// `Effect.dieMessage` whose message describes a TIMEOUT — an expected outcome
// that must fail (typed) so it lands on the test that caused it, not escape as
// an unattributed defect.
//
// Cases (4 total):
//   1. `Effect.die(new Error("Timed out waiting for ..."))`
//   2. `Effect.dieMessage("timeout waiting for state")`
//   3. template-literal message ("timed out")
//   4. a timeout die with a malformed comment (missing reason)

import { Effect } from "effect"

export const timedOut = () => Effect.die(new Error("Timed out waiting for runtime state"))

export const withMessage = () => Effect.dieMessage("timeout waiting for state")

export const templated = (label: string) =>
  Effect.gen(function* () {
    return yield* Effect.die(new Error(`timed out waiting for ${label}`))
  })

// gent/no-die-in-test-helpers: allow
export const malformedCarveout = () => Effect.die(new Error("gave up waiting for the queue"))
