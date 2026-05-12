// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-sleep` does NOT fire when a well-formed
// `// gent/no-sleep: allow <reason>` carveout sits immediately above the
// call, OR on the same trailing line.

import { Effect } from "effect"

// gent/no-sleep: allow real-clock timing test for idle eviction
export const realClockTiming = () => Effect.sleep("100 millis")

export const trailingCarveout = () =>
  Effect.sleep("50 millis") // gent/no-sleep: allow OS-level fiber pacing for PTY fixture

// gent/no-sleep: allow retry-helper subject under test exercises backoff schedule
export const retryHelper = () => Effect.sleep("250 millis")
