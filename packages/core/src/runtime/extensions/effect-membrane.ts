import { Context, Effect, Layer } from "effect"
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
export type ErasedLayer = Layer.Layer<any, any, any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
export type ErasedContextKey = Context.Key<any, any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
export type ErasedResourceLayer = Layer.Layer<any>

/**
 * Membrane for heterogeneous Effect layers.
 *
 * Runtime and extension layers can provide different service tags, fail with
 * owner-local errors, and require scope-branded host services. Composition
 * roots intentionally erase those channels only at assembly time so they can
 * merge an unknown extension set.
 */
export const eraseLayer = <I, E, R>(layer: Layer.Layer<I, E, R>): ErasedLayer =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit resource-layer membrane
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  layer as unknown as ErasedLayer

export const emptyErasedLayer: ErasedLayer =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  Layer.empty as unknown as ErasedLayer

export const eraseContextKey = (key: unknown): ErasedContextKey =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  key as unknown as ErasedContextKey

export const omitErasedContext = (
  ctx: Context.Context<never>,
  keys: ReadonlyArray<ErasedContextKey>,
): Context.Context<never> => {
  if (keys.length === 0) return ctx
  return Context.omit(...keys)(ctx) as Context.Context<never>
}

export const mergeErasedLayers = (layers: ReadonlyArray<ErasedLayer>): ErasedLayer => {
  const [first, ...rest] = layers
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit layer-erasure membrane
  if (first === undefined) return emptyErasedLayer
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit layer-erasure membrane
  if (rest.length === 0) return first
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit layer-erasure membrane
  return Layer.mergeAll(first, ...rest)
}

export const restoreErasedLayer = <I, E = never, R = never>(
  layer: ErasedLayer,
): Layer.Layer<I, E, R> =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit layer-erasure membrane
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  layer as Layer.Layer<I, E, R>

/**
 * Restore a phantom type after reading from an explicitly erased runtime store.
 *
 * Keep this helper for host-owned storage membranes only: actor refs, ask
 * replies, streams, and similar values whose real type is fixed by the key/ref
 * used at the call site but cannot be represented inside a heterogeneous map.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- call sites recover phantom types from erased stores
export const restoreErasedValue = <A>(value: unknown): A =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  value as A

/**
 * Resource-host call sites keep the old narrower return type (`Layer.Layer<any>`)
 * so resource layers do not leak an `unknown` requirement channel into tests.
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
