// @ts-nocheck — fixture file consumed by lint/fixtures.test.ts; not part of the build
// EXPECTED: rule `gent/no-runpromise-outside-boundary` fires
import { Effect } from "effect"

export const bad = () => Effect.runPromise(Effect.succeed(1))
export const badWith = () => Effect.runPromiseWith(undefined as never)(Effect.succeed(1))
