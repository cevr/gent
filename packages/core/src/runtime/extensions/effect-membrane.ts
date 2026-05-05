import { Context, Layer } from "effect"

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
export type ErasedLayer = Layer.Layer<any, any, any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
export type ErasedContextKey = Context.Key<any, any>

/**
 * Membrane for heterogeneous Effect layers.
 *
 * Runtime and extension layers can provide different service tags, fail with
 * owner-local errors, and require scope-branded host services. Composition
 * roots intentionally erase those channels only at assembly time so they can
 * merge an unknown extension set.
 */
export const eraseLayer = <I, E, R>(layer: Layer.Layer<I, E, R>): ErasedLayer =>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
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
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  layer as Layer.Layer<I, E, R>

/**
 * Restore a phantom type after reading from an explicitly erased runtime store.
 *
 * Keep this helper for host-owned storage membranes only: request replies,
 * streams, and similar values whose real type is fixed by the key/ref used at
 * the call site but cannot be represented inside a heterogeneous map.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- call sites recover phantom types from erased stores
export const restoreErasedValue = <A>(value: unknown): A => value as A
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */
