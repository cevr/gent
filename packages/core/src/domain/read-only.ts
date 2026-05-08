/**
 * `ReadOnly` brand — type-level fence for service Tags that must be
 * usable from read-only contexts (`request({ intent: "read" })`
 * capabilities) without leaking write capability.
 *
 * Per-service `*ReadOnly` Tags make a write-capable Tag a compile
 * error in read-intent R-channels.
 *
 * Usage:
 *   - Define a service-shape interface as you normally would.
 *   - When declaring its Context.Tag, brand the inner shape with
 *     `ReadOnly<MyServiceShape>` to lock it as read-only at the type
 *     level.
 *   - For services with mixed read/write, split into two Tags
 *     (`MyServiceReadOnly` carrying only the read methods,
 *     `MyServiceAdmin` carrying the writes). The Live layer can
 *     provide both Tags from the same underlying state.
 *
 * The value brand is also applied as a non-enumerable runtime marker by
 * `withReadOnly(...)`. Read-intent hosts use that marker to derive a
 * context that contains only read-only service values, so the type
 * fence has a matching runtime fence.
 *
 * @module
 */

import { Context } from "effect"

/**
 * Read-only brand symbol — exported so per-Tag classes can declare
 * the brand directly on their identifier (`declare readonly
 * [ReadOnlyBrand]: true`). The symbol value exists at runtime (so
 * `import { ReadOnlyBrand }` resolves through the bundler). Tag class
 * declarations use `declare readonly`; service values get the runtime
 * marker through `withReadOnly(...)`.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- process-global symbol keeps the runtime brand stable across package subpath aliases
export const ReadOnlyBrand: unique symbol = Symbol.for("@gent/core/ReadOnlyBrand") as never

/** Phantom brand applied to read-only service identifiers + shapes. */
export interface ReadOnlyTag {
  readonly [ReadOnlyBrand]: true
}

/** A service shape `S` branded as read-only. */
export type ReadOnly<S> = S & ReadOnlyTag

/**
 * Brand a service-shape value as read-only. Use at Tag construction
 * sites where the shape carries only read methods.
 *
 * The companion brand on the Tag identifier is declared on the Tag class
 * itself:
 *
 * @example
 * ```ts
 * interface MyServiceShape { readonly get: () => Effect<Value> }
 * export class MyService extends Context.Service<
 *   MyService,
 *   ReadOnly<MyServiceShape>
 * >()("@me/MyService") {
 *   // Brand the class identifier so `yield* MyService` produces
 *   // `R extends ReadOnlyTag` for read-intent R-channels.
 *   declare readonly [ReadOnlyBrand]: true
 * }
 * ```
 */
export const withReadOnly = <S>(value: S): ReadOnly<S> => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.defineProperty(value, ReadOnlyBrand, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    })
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type/runtime boundary
  return value as ReadOnly<S>
}

const hasReadOnlyRuntimeBrand = (value: unknown): value is ReadOnlyTag =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  ReadOnlyBrand in value

export const readOnlyCapabilityContext = (
  context: Context.Context<never> | undefined,
): Context.Context<never> | undefined => {
  if (context === undefined) return undefined
  const map = new Map<string, unknown>()
  for (const [key, value] of context.mapUnsafe) {
    if (hasReadOnlyRuntimeBrand(value)) {
      map.set(key, value)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- read-only runtime membrane filters erased extension services
  return Context.makeUnsafe(map) as Context.Context<never>
}
