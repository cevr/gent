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

import { Context, Layer } from "effect"
import { resolveExtensions, type ResolvedExtensions } from "./extensions/registry.js"
import type { CwdScope, EphemeralScope, ServerScope } from "../domain/scope-brand.js"

export type { CwdScope, EphemeralScope, ServerScope } from "../domain/scope-brand.js"

/**
 * A profile resolved against a `cwd`, parameterised by the scope-brand it owns.
 *
 * Three concrete instantiations: {@link ServerProfile}, {@link CwdProfile},
 * {@link EphemeralProfile}. The `S` parameter prevents a `CwdProfile` from
 * being passed where an `EphemeralProfile` is required and vice-versa.
 *
 * The brand lives on the `__brand` slot (zero-cost phantom field). The live
 * `Scope.Scope` instance is acquired separately at composition-root setup
 * time; this profile is a pure data carrier.
 */
export interface Profile<S> {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly __brand: S
}

export type ServerProfile = Profile<ServerScope>
export type CwdProfile = Profile<CwdScope>
export type EphemeralProfile = Profile<EphemeralScope>

/**
 * Brand a `{ cwd, resolved }` payload as a {@link ServerProfile}.
 *
 * **Restricted**: only the server composition root (`packages/core/src/server/dependencies.ts`)
 * may call this. Lint rule `gent/brand-constructor-callers` enforces.
 */
export const brandServerScope = (profile: {
  cwd: string
  resolved: ResolvedExtensions
}): ServerProfile =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
  ({ ...profile, __brand: undefined as unknown as ServerScope }) as ServerProfile

/**
 * Brand a `{ cwd, resolved }` payload as a {@link CwdProfile}.
 *
 * **Restricted**: only `session-profile.ts` (the per-cwd profile cache) may call this.
 */
export const brandCwdScope = (profile: { cwd: string; resolved: ResolvedExtensions }): CwdProfile =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
  ({ ...profile, __brand: undefined as unknown as CwdScope }) as CwdProfile

/**
 * Brand a `{ cwd, resolved }` payload as an {@link EphemeralProfile}.
 *
 * **Restricted**: only `agent-runner.ts` (and the `RuntimeComposer.ephemeral`
 * builder it consumes) may call this.
 */
export const brandEphemeralScope = (profile: {
  cwd: string
  resolved: ResolvedExtensions
}): EphemeralProfile =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime internal owns erased generic boundary
  ({ ...profile, __brand: undefined as unknown as EphemeralScope }) as EphemeralProfile

/**
 * Service tag carrying the {@link ServerProfile} for the running server
 * composition root. Published by `server/dependencies.ts` at startup; read by
 * the agent-runner (and other consumers that need a typed proof-of-origin
 * when calling `RuntimeComposer.ephemeral(...)`).
 *
 * Why a service tag instead of a function-arg: the consumer (agent-runner)
 * lives downstream of the composition root and shouldn't have to thread the
 * profile through every constructor. Effect services are exactly the
 * mechanism for "constructed once, read where needed."
 */
export class ServerProfileService extends Context.Service<ServerProfileService, ServerProfile>()(
  "@gent/core/src/runtime/scope-brands/ServerProfileService",
) {
  /**
   * Test layer providing a minimal {@link ServerProfile} (empty extensions,
   * caller-supplied cwd) for unit/integration tests that exercise the
   * agent-runner without spinning up a full server composition root.
   */
  static Test = (cwd = "/tmp"): Layer.Layer<ServerProfileService> =>
    Layer.succeed(
      ServerProfileService,
      brandServerScope({
        cwd,
        resolved: resolveExtensions([]),
      }),
    )
}
