import { Context, Effect } from "effect"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type { ProjectionTurnContext } from "../../domain/extension.js"

export interface ExtensionReactionContext {
  readonly projection: ProjectionTurnContext
  readonly host: ExtensionHostContext
}

export class CurrentReactionHostContext extends Context.Service<
  CurrentReactionHostContext,
  ExtensionHostContext
>()("@gent/core/src/runtime/extensions/extension-reaction-context/CurrentReactionHostContext") {}

export class CurrentProjectionReactionContext extends Context.Service<
  CurrentProjectionReactionContext,
  ProjectionTurnContext
>()(
  "@gent/core/src/runtime/extensions/extension-reaction-context/CurrentProjectionReactionContext",
) {}

export const provideReactionHostContext =
  (hostCtx: ExtensionHostContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentReactionHostContext>> =>
    effect.pipe(Effect.provideService(CurrentReactionHostContext, hostCtx))

export const provideExtensionReactionContext =
  (ctx: ExtensionReactionContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E,
    Exclude<Exclude<R, CurrentReactionHostContext>, CurrentProjectionReactionContext>
  > =>
    effect.pipe(
      Effect.provideService(CurrentReactionHostContext, ctx.host),
      Effect.provideService(CurrentProjectionReactionContext, ctx.projection),
    )
