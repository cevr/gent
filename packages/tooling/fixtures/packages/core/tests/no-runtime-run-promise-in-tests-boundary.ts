// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-runtime-run-promise-in-tests` does NOT fire. A
// `-boundary` file holds a test's Promise edges.
import { Effect } from "effect"

declare const runtime: { runPromise: (effect: Effect.Effect<string>) => Promise<string> }

export const edge = runtime.runPromise(Effect.succeed("work"))
