// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-runtime-run-promise-in-tests` fires 4 times. The
// harness is test code, and upstream reads only the `Effect.run*` statics
// here: a runtime's `runPromise` passes both upstream rules.
import { Effect } from "effect"

declare const runtime: { runPromise: (effect: Effect.Effect<string>) => Promise<string> }
declare const ui: {
  clientRuntime: { runPromiseExit: (effect: Effect.Effect<string>) => Promise<unknown> }
}
declare const rt: { runPromiseWith: (effect: Effect.Effect<string>) => Promise<string> }

export const direct = runtime.runPromise(Effect.succeed("work"))
export const nested = ui.clientRuntime.runPromiseExit(Effect.succeed("work"))
export const anyReceiver = rt.runPromiseWith(Effect.succeed("work"))
export const piped = Effect.succeed("work").pipe(runtime.runPromise)
