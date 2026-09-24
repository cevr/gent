/**
 * SDK runtime boundary — owns `GentRuntime` and its factory.
 *
 * `GentRuntime.run` is the Promise edge users invoke from their host
 * (CLI, test harness, web server). The Effect they pass crosses into
 * Promise-land here. `cast` and `fork` use `runForkWith` (Effect-internal,
 * not a Promise edge) but live alongside `run` because they share the
 * same captured `services` context — the runtime IS the boundary surface.
 *
 * Per `gent/no-runpromise-outside-boundary`, the Promise edge lives in
 * a `*-boundary.ts` module. The export names the specific external seam.
 */

import { Effect, type Context, type Fiber } from "effect"
import type { GentLifecycle } from "@gent/core/protocol"

// ---------------------------------------------------------------------------
// GentRuntime — execution surface for the caller
// ---------------------------------------------------------------------------

export interface GentRuntime<Services = unknown> {
  /** Fire-and-forget — run an effect without awaiting result */
  readonly cast: <A, E, R extends Services>(effect: Effect.Effect<A, E, R>) => void
  /** Fork with a handle — caller can join/interrupt */
  readonly fork: <A, E, R extends Services>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  /** Await result as a Promise */
  readonly run: <A, E, R extends Services>(effect: Effect.Effect<A, E, R>) => Promise<A>
  /** Connection lifecycle */
  readonly lifecycle: GentLifecycle
}

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
