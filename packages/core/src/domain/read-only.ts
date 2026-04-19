/**
 * `ReadOnly` brand — type-level fence for service Tags that must be
 * usable from read-only contexts (projections + `request({ intent: "read" })`
 * capabilities) without leaking write capability.
 *
 * Background: pre-B11.4 the `gent/no-projection-writes` lint rule
 * heuristically scanned projection R-channels for known-write services
 * (e.g. `Skills.reload()`, `MemoryVault.rebuildIndex()`). The heuristic
 * missed plenty (any new write surface bypasses it; lint runs after
 * code lands). B11.4 replaces the heuristic with a structural type
 * fence: `ProjectionContribution<A, R extends ReadOnlyTag = never>`
 * + `MachineExecute & ReadOnlyTag` + per-service `*ReadOnly` Tags
 * make a write-capable Tag a compile error in any read-only R-channel.
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
 * The brand is a phantom property — no runtime cost, no instance
 * marker. It is invisible to JavaScript value-comparison and lives
 * only at the type level.
 *
 * @module
 */

/**
 * Phantom brand symbol — exported so per-Tag classes can declare
 * the brand directly on their identifier (`declare readonly
 * [ReadOnlyBrand]: true`). The symbol value exists at runtime (so
 * `import { ReadOnlyBrand }` resolves through the bundler) but the
 * brand itself is type-only — class declarations use `declare readonly`,
 * never assigning the property at runtime.
 */
export const ReadOnlyBrand: unique symbol = Symbol.for("@gent/core/ReadOnlyBrand")

/** Phantom brand applied to read-only service identifiers + shapes. */
export interface ReadOnlyTag {
  readonly [ReadOnlyBrand]: true
}

/** A service shape `S` branded as read-only. */
export type ReadOnly<S> = S & ReadOnlyTag

/**
 * Brand a service-shape value as read-only. Type-level fence only —
 * the runtime value is unchanged. Use at Tag construction sites where
 * the shape carries only read methods.
 *
 * The companion brand on the Tag identifier (so projection R-channels
 * resolve under the `R extends ReadOnlyTag` fence in
 * `ProjectionContribution`) is declared on the Tag class itself:
 *
 * @example
 * ```ts
 * interface MyServiceShape { readonly get: () => Effect<Value> }
 * export class MyService extends Context.Service<
 *   MyService,
 *   ReadOnly<MyServiceShape>
 * >()("@me/MyService") {
 *   // Brand the class identifier so `yield* MyService` produces
 *   // `R extends ReadOnlyTag` for projection R-channels.
 *   declare readonly [ReadOnlyBrand]: true
 * }
 * ```
 */
export const withReadOnly = <S>(value: S): ReadOnly<S> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  value as ReadOnly<S>
