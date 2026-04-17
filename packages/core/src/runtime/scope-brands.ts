/**
 * Nominal scope brands for the three composition roots.
 *
 * Encodes the lifetime of a `Scope.Scope` at the type level so the runtime
 * cannot accidentally inject a process-scoped service into an ephemeral
 * consumer's Layer (the bug class that produced the 14-item `Context.omit`
 * list in `agent-runner.ts`).
 *
 * Three composition roots, three brands:
 *
 *   - {@link ServerScope}    — survives for the server's lifetime (process)
 *   - {@link CwdScope}       — survives per-cwd, owned by the per-cwd profile cache
 *   - {@link EphemeralScope} — survives for one ephemeral child run only
 *
 * Profiles thread the brand: `ServerProfile`, `CwdProfile`, `EphemeralProfile`.
 * A Resource declared `scope: "session"` requires `EphemeralScope` to instantiate;
 * a `scope: "process"` Resource requires `ServerScope`. Cross-scope leakage fails
 * to compile because the nominal brands do not unify.
 *
 * NOTE: this module is **type-only** scaffolding. C1 wires `RuntimeComposer`
 * over these brands and replaces `agent-runner.ts:549-565`'s `Context.omit`
 * with type-driven scope guarantees.
 *
 * @module
 */

import type { Scope } from "effect"
import type { ResolvedExtensions } from "./extensions/registry.js"

declare const ServerBrand: unique symbol
declare const CwdBrand: unique symbol
declare const EphemeralBrand: unique symbol

/** A `Scope.Scope` that survives for the server process. */
export type ServerScope = Scope.Scope & { readonly [ServerBrand]: true }

/** A `Scope.Scope` owned by the per-cwd profile cache; survives as long as the cache entry. */
export type CwdScope = Scope.Scope & { readonly [CwdBrand]: true }

/** A `Scope.Scope` that survives for one ephemeral child run. */
export type EphemeralScope = Scope.Scope & { readonly [EphemeralBrand]: true }

/**
 * A profile resolved against a `cwd`, parameterised by the scope-brand it owns.
 *
 * Three concrete instantiations: {@link ServerProfile}, {@link CwdProfile},
 * {@link EphemeralProfile}. The `S` parameter prevents a `CwdProfile` from
 * being passed where an `EphemeralProfile` is required and vice-versa.
 */
export interface Profile<S extends Scope.Scope> {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly scope: S
}

export type ServerProfile = Profile<ServerScope>
export type CwdProfile = Profile<CwdScope>
export type EphemeralProfile = Profile<EphemeralScope>

/**
 * Brand a raw `Scope.Scope` as a {@link ServerScope}.
 *
 * **Restricted**: only the server composition root (`packages/core/src/server/dependencies.ts`)
 * may call this. Other call sites must receive a `ServerScope` from above.
 */
export const brandServerScope = (scope: Scope.Scope): ServerScope =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  scope as ServerScope

/**
 * Brand a raw `Scope.Scope` as a {@link CwdScope}.
 *
 * **Restricted**: only `session-profile.ts` (the per-cwd profile cache) may call this.
 */
export const brandCwdScope = (scope: Scope.Scope): CwdScope =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  scope as CwdScope

/**
 * Brand a raw `Scope.Scope` as an {@link EphemeralScope}.
 *
 * **Restricted**: only `agent-runner.ts` (the ephemeral child-run path) may call this.
 */
export const brandEphemeralScope = (scope: Scope.Scope): EphemeralScope =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  scope as EphemeralScope
