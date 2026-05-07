/**
 * Boundary helper for extension UI loading.
 *
 * Solid's `onMount` callback runs in the Promise lane (sync setup -> async
 * effect callback). When that callback needs to await host-owned Effect
 * helpers, we exit Effect-land via `clientRuntime.runPromise(...)` here.
 *
 * Each export names a specific external seam. There is no generic
 * `runAnyEffect(runtime, effect)` trampoline.
 */

import { Effect } from "effect"
import { readDisabledExtensions } from "@gent/core/runtime/extensions/disabled"
import type { AnyExtensionClientModule, ClientRuntime } from "../extensions/client-facets.js"
import { loadTuiExtensions } from "../extensions/loader-boundary"
import type { ResolvedTuiExtensions } from "../extensions/resolve"

/**
 * Resolve the disabled-extensions set for the current workspace by reading
 * user + project config. The Effect runs through `clientRuntime.runPromise`
 * so the awaited result lands directly in `onMount`'s sync flow.
 */
export const loadDisabledExtensions = (
  clientRuntime: ClientRuntime,
  params: { home: string; cwd: string },
): Promise<ReadonlySet<string>> => clientRuntime.runPromise(readDisabledExtensions(params))

export const loadExtensionUi = (
  clientRuntime: ClientRuntime,
  params: {
    readonly builtins: ReadonlyArray<AnyExtensionClientModule>
    readonly home: string
    readonly cwd: string
  },
): Promise<ResolvedTuiExtensions> =>
  clientRuntime.runPromise(
    Effect.gen(function* () {
      const disabledSet = yield* readDisabledExtensions({ home: params.home, cwd: params.cwd })
      return yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: params.builtins,
          userDir: `${params.home}/.gent/extensions`,
          projectDir: `${params.cwd}/.gent/extensions`,
          disabled: [...disabledSet],
          runtime: clientRuntime,
        }),
      )
    }),
  )
