// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-timeout-die-payload-in-tests` does NOT fire. Product
// code is not test code.
import { Effect } from "effect"

export const productDie = Effect.die({ reason: "timed out" })
