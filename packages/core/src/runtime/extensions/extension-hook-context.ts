import { Context, Effect } from "effect"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { ProjectionTurnContext } from "../../domain/extension.js"

export interface ExtensionHookContext {
  readonly projection: ProjectionTurnContext
  readonly host: ExtensionHostContext
}

export class CurrentHookHostContext extends Context.Service<
  CurrentHookHostContext,
  ExtensionHostContext
>()("@gent/core/src/runtime/extensions/extension-hook-context/CurrentHookHostContext") {}

export class CurrentProjectionHookContext extends Context.Service<
  CurrentProjectionHookContext,
  ProjectionTurnContext
>()("@gent/core/src/runtime/extensions/extension-hook-context/CurrentProjectionHookContext") {}

export const provideHookHostContext =
  (hostCtx: ExtensionHostContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentHookHostContext>> =>
    effect.pipe(Effect.provideService(CurrentHookHostContext, hostCtx))

export const provideExtensionHookContext =
  (ctx: ExtensionHookContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E,
    Exclude<Exclude<R, CurrentHookHostContext>, CurrentProjectionHookContext>
  > =>
    effect.pipe(
      Effect.provideService(CurrentHookHostContext, ctx.host),
      Effect.provideService(CurrentProjectionHookContext, ctx.projection),
    )
