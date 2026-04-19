/**
 * Boundary helper for {@link ExtensionUIProvider} (`context.tsx`).
 *
 * Solid's `onMount` callback runs in the Promise lane (sync setup → async
 * effect callback). When that callback needs to await an `Effect` produced
 * by a core helper (today: `readDisabledExtensions`), we exit Effect-land
 * via `clientRuntime.runPromise(...)`. Per `gent/no-runpromise-outside-
 * boundary`, that call lives here.
 *
 * Each export NAMES a specific external seam — there's no generic
 * `runAnyEffect(runtime, effect)` trampoline, because that would let any
 * non-boundary file create new Promise edges by laundering through this
 * module (counsel B11.2a finding).
 */

import { type ManagedRuntime } from "effect"
import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"

/**
 * Resolve the disabled-extensions set for the current workspace by reading
 * user + project config. The Effect runs through `clientRuntime.runPromise`
 * so the awaited result lands directly in `onMount`'s sync flow.
 */
export const loadDisabledExtensions = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter boundary; the caller's runtime layer shape is opaque to this helper, but it must provide FileSystem | Path for `readDisabledExtensions`
  clientRuntime: ManagedRuntime.ManagedRuntime<any, never>,
  params: { home: string; cwd: string },
): Promise<ReadonlySet<string>> => clientRuntime.runPromise(readDisabledExtensions(params))
