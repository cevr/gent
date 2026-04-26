/**
 * Pure type-level scope brands used in domain types. Live profile carriers
 * (`Profile<S>`, `ServerProfileService`, `brandServerScope`, etc.) and any
 * runtime imports stay in `runtime/scope-brands.ts`, which re-exports the
 * brand types defined here.
 *
 * Encodes the lifetime of a `Scope.Scope` at the type level so the runtime
 * cannot accidentally inject a process-scoped service into an ephemeral
 * consumer's Layer.
 *
 * Three composition roots, three brands:
 *
 *   - {@link ServerScope}    — survives for the server's lifetime (process)
 *   - {@link CwdScope}       — survives per-cwd, owned by the per-cwd profile cache
 *   - {@link EphemeralScope} — survives for one ephemeral child run only
 *
 * These types carry no runtime payload — they are purely structural markers
 * used for nominal typing on `Profile<S>` carriers.
 *
 * @module
 */

declare const ServerBrand: unique symbol
declare const CwdBrand: unique symbol
declare const EphemeralBrand: unique symbol

export type ServerScope = { readonly [ServerBrand]: true }
export type CwdScope = { readonly [CwdBrand]: true }
export type EphemeralScope = { readonly [EphemeralBrand]: true }
