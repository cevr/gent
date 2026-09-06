import { Context, Effect } from "effect"

export const CurrentExtensionCapabilityContext = Context.Reference<Context.Context<never>>(
  "@gent/core/src/runtime/extensions/extension-capability-context/CurrentExtensionCapabilityContext",
  {
    defaultValue: Context.empty,
  },
)

export const provideCurrentCapabilityContext =
  (capabilityContext: Context.Context<never> = Context.empty()) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.provideService(CurrentExtensionCapabilityContext, capabilityContext))

export const provideExtensionCapabilityContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const capabilityContext = yield* CurrentExtensionCapabilityContext
    return yield* effect.pipe(Effect.provideContext(capabilityContext))
  })
