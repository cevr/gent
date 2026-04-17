// @ts-nocheck — fixture file: filename ends in `-boundary.ts`, so the rule must NOT fire
// EXPECTED: rule `gent/no-runpromise-outside-boundary` does NOT fire
import { Effect } from "effect"

export const ok = () => Effect.runPromise(Effect.succeed(1))
