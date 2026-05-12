// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-sleep` fires for every `.sleep(...)` shape in
// test code that lacks an `// gent/no-sleep: allow <reason>` carveout.
//
// Cases (5 total):
//   1. `Effect.sleep("0 millis")` with no comment
//   2. `Effect.sleep("10 millis")` with no comment
//   3. `Bun.sleep(0)` with no comment
//   4. `Effect.sleep(Duration.millis(100))` with no comment
//   5. `Effect.sleep(...)` with a malformed comment (missing reason)

import { Effect, Duration } from "effect"

export const zeroMillis = () => Effect.sleep("0 millis")

export const tenMillis = () => Effect.sleep("10 millis")

export const bunSleepZero = () => Bun.sleep(0)

export const durationMillis = () => Effect.sleep(Duration.millis(100))

// gent/no-sleep: allow
export const malformedCarveout = () => Effect.sleep("20 millis")
