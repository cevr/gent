// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-sleep` fires once. The harness is test code: a
// fixed delay here paces every test that calls it.
import { Effect } from "effect"

export const settle = Effect.sleep("20 millis")
