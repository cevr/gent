/**
 * Boundary helpers for {@link ExtensionUIProvider} (`context.tsx`).
 *
 * Solid's `onMount` callback runs in the Promise lane (sync setup → async
 * effect callback). When that callback needs to await an `Effect` produced
 * by a core helper (e.g., `readDisabledExtensions`), we exit Effect-land
 * via `clientRuntime.runPromise(...)`. Per `gent/no-runpromise-outside-
 * boundary`, that call lives here.
 */

import { type Effect, type ManagedRuntime } from "effect"

export const runClientEffect = <A, E, R>(
  clientRuntime: ManagedRuntime.ManagedRuntime<R, never>,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => clientRuntime.runPromise(effect)
