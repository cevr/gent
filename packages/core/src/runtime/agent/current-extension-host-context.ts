import { Context, Effect } from "effect"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"

export const CurrentExtensionHostContext = Context.Reference<ExtensionHostContext>(
  "@gent/core/src/runtime/agent/current-extension-host-context/CurrentExtensionHostContext",
  {
    defaultValue: () => {
      throw new Error("CurrentExtensionHostContext not provided")
    },
  },
)

export const withCurrentHostCtx = <A, E, R>(
  hostCtx: ExtensionHostContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(CurrentExtensionHostContext, hostCtx))
