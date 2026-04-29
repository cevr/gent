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
 * module (counsel  finding).
 */

import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"
import type { ClientRuntime } from "./client-facets.js"

/**
 * Resolve the disabled-extensions set for the current workspace by reading
 * user + project config. The Effect runs through `clientRuntime.runPromise`
 * so the awaited result lands directly in `onMount`'s sync flow.
 *
 * The runtime type is pinned to the TUI client runtime — the effect being run
 * remains fixed to `readDisabledExtensions`, so this helper cannot launder
 * arbitrary Effects through a Promise edge.
 */
export const loadDisabledExtensions = (
  clientRuntime: ClientRuntime,
  params: { home: string; cwd: string },
): Promise<ReadonlySet<string>> => clientRuntime.runPromise(readDisabledExtensions(params))
