// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-sleep` does NOT fire. A `-boundary` file in shipped
// source is product code; only a test's boundary file is test code.
import { Effect } from "effect"

export const backoff = Effect.sleep("20 millis")
