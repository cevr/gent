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

import { type FileSystem, type ManagedRuntime, type Path } from "effect"
import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"

/**
 * Resolve the disabled-extensions set for the current workspace by reading
 * user + project config. The Effect runs through `clientRuntime.runPromise`
 * so the awaited result lands directly in `onMount`'s sync flow.
 *
 * The runtime type is pinned to exactly the services `readDisabledExtensions`
 * needs (`FileSystem.FileSystem | Path.Path`) — see the loader-boundary
 * precedent — so the caller cannot launder extra Effects through this helper.
 */
export const loadDisabledExtensions = (
  clientRuntime: ManagedRuntime.ManagedRuntime<FileSystem.FileSystem | Path.Path, never>,
  params: { home: string; cwd: string },
): Promise<ReadonlySet<string>> => clientRuntime.runPromise(readDisabledExtensions(params))
