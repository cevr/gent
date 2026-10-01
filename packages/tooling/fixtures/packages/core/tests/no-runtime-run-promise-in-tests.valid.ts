// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-runtime-run-promise-in-tests` does NOT fire. An
// `Effect.run*` static is upstream `effect/noEffectRunInTests`'s to report.
import { Effect } from "effect"

export const statics = Effect.runPromise(Effect.succeed("work"))
export const piped = Effect.succeed("work").pipe(Effect.runPromiseExit)
