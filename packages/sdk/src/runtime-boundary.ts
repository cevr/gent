/**
 * SDK runtime boundary — exposes the `GentRuntime` factory.
 *
 * `GentRuntime.run` is the Promise edge users invoke from their host
 * (CLI, test harness, web server). The Effect they pass crosses into
 * Promise-land here. `cast` and `fork` use `runForkWith` (Effect-internal,
 * not a Promise edge) but live alongside `run` because they share the
 * same captured `services` context — the runtime IS the boundary surface.
 *
 * Per `gent/no-runpromise-outside-boundary`, the Promise edge lives in
 * a `*-boundary.ts` module. The export NAMES the specific external seam
 * — there is no generic `runAnyEffect` trampoline.
 */

import { Effect, type Context } from "effect"
import type { GentLifecycle, GentRuntime } from "./namespaced-client.js"

export const makeGentRuntime = <Services>(
  services: Context.Context<Services>,
  lifecycle: GentLifecycle,
): GentRuntime<Services> => ({
  cast: (effect) => {
    Effect.runForkWith(services)(effect)
  },
  fork: (effect) => Effect.runForkWith(services)(effect),
  run: (effect) => Effect.runPromiseWith(services)(effect),
  lifecycle,
})
