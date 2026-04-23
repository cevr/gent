import { Effect, Layer, Scope } from "effect"

/**
 * Build a layer inside the current scope, then run an effect inside the
 * resulting service context.
 *
 * Use this when the code owns a layer but wants execution to happen against
 * the layer's already-built context. Callers that already hold a built
 * `Context` should use `Effect.provideContext` directly.
 */
export const runWithBuiltLayer =
  <I, E2, R2>(layer: Layer.Layer<I, E2, R2>) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | E2, Exclude<R, I> | R2 | Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const built = yield* Layer.buildWithScope(layer, scope)
      return yield* Effect.provideContext(effect, built)
    })
