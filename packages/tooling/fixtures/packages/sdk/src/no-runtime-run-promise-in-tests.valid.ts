// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-runtime-run-promise-in-tests` does NOT fire. Product
// code is not test code; its Promise edges are upstream `effect/noRunPromise`'s.
import { Effect } from "effect"

declare const runtime: { runPromise: (effect: Effect.Effect<string>) => Promise<string> }

export const edge = runtime.runPromise(Effect.succeed("work"))
