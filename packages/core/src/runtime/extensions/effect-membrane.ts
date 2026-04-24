import { Effect, Layer } from "effect"
import type { Exit } from "effect"

export interface ErasedEffectHandlers<A, E> {
  readonly onFailure: (error: unknown) => Effect.Effect<A, E>
  readonly onDefect: (defect: unknown) => Effect.Effect<A, E>
}

/**
 * Single membrane for extension-authored `Effect<A, E, R>` values whose `E`
 * and `R` channels are intentionally erased at the host boundary.
 *
 * `Effect.suspend` is load-bearing: it captures synchronous throws during
 * effect construction so hosts do not need a second `Effect.try` wrapper just
 * to seal them.
 */
export const sealErasedEffect = <A, E>(
  effect: () => Effect.Effect<A, unknown, unknown>,
  handlers: ErasedEffectHandlers<A, E>,
  // The membrane intentionally erases the extension effect's `R` channel.
  // Callers use this ONLY at host boundaries where the extension runtime has
  // already provided the required services.
): Effect.Effect<A, E> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit erased-effect membrane
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  Effect.suspend(effect).pipe(
    Effect.catchEager(handlers.onFailure),
    Effect.catchDefect(handlers.onDefect),
  ) as Effect.Effect<A, E>

/**
 * Variant for hosts that need the raw `Exit` to apply local failure policy
 * (`continue` / `isolate` / `halt`, lifecycle finalizer behavior, etc.).
 */
export const exitErasedEffect = <A>(
  effect: () => Effect.Effect<A, unknown, unknown>,
): Effect.Effect<Exit.Exit<A, unknown>> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit erased-effect membrane
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  Effect.exit(Effect.suspend(effect)) as Effect.Effect<Exit.Exit<A, unknown>>

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
export type ErasedResourceLayer = Layer.Layer<any>

/**
 * Membrane for heterogeneous extension Resource layers.
 *
 * Resource layers can provide different service tags, fail with extension-owned
 * errors, and require scope-branded host services. ResourceHost intentionally
 * erases those channels only at assembly time so the composition root can merge
 * an unknown extension set.
 */
export const eraseResourceLayer = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
  layer: Layer.Layer<any, any, any>,
): ErasedResourceLayer =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit resource-layer membrane
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  layer as ErasedResourceLayer

export const emptyErasedResourceLayer: ErasedResourceLayer =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  Layer.empty as ErasedResourceLayer
