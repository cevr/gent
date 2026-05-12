import { Context, Effect } from "effect"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"

export class CurrentExtensionHostContext extends Context.Service<
  CurrentExtensionHostContext,
  ExtensionHostContext
>()("@gent/core/src/runtime/agent/current-extension-host-context/CurrentExtensionHostContext") {}

export const provideCurrentHostCtx =
  (hostCtx: ExtensionHostContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentExtensionHostContext>> =>
    effect.pipe(Effect.provideService(CurrentExtensionHostContext, hostCtx))
