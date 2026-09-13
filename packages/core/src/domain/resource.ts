/**
 * Resource — long-lived state with explicit scope.
 *
 * Replaces single-purpose contribution kinds (`layer`, `lifecycle`,
 * `workflow.machine`) with one primitive that
 * carries the unifying concept: "this extension owns a long-lived service
 * with optional startup/shutdown."
 *
 * The `scope` discriminator is intentionally narrow. The host owns two
 * long-lived resource lifetimes:
 *
 *   - `"process"` — survives for the server's lifetime; requires `ServerScope`
 *   - `"branch"`  — survives for one agent-loop branch; requires `BranchScope`
 *
 * Add more scope literals only with their host lifecycle implementation in the
 * same wave. Advertising `session`/`cwd` without a runtime owner makes
 * impossible lifetimes look supported.
 *
 * @module
 */

import { Schema } from "effect"
import type { Context, Effect, Layer } from "effect"

/** Stable identity for a declared resource. */
export const ResourceId = Schema.NonEmptyString.pipe(Schema.brand("ResourceId"))
export type ResourceId = typeof ResourceId.Type

// ── Scope discriminator + brand mapping ──

/**
 * Pure type-level scope brand used by Resource declarations. Encodes the
 * lifetime of a `Scope.Scope` at the type level. `ServerScope` survives for the
 * server's lifetime. Add new brands only when their resource host lifecycle
 * exists. These types carry no runtime payload; they are purely structural.
 */
declare const ServerBrand: unique symbol
type ServerScope = { readonly [ServerBrand]: true }

/**
 * One agent-loop branch's lifetime. The actor forks a child of its own scope
 * per loop rebuild and transfers it to the published loop handle, so a branch
 * resource is released when that branch closes.
 */
declare const BranchBrand: unique symbol
type BranchScope = { readonly [BranchBrand]: true }

/** Runtime literal-string union for Resource lifetimes. */
export type ResourceScope = "process" | "branch"

/**
 * Type-level mapping from the `scope` literal to the corresponding nominal
 * scope brand. The brand flows into the `R` channel of the Resource's `layer`.
 */
type ScopeOf<S extends ResourceScope> = S extends "process"
  ? ServerScope
  : S extends "branch"
    ? BranchScope
    : never

// ── The Resource contribution ──

/**
 * One Resource carries:
 *
 * - `id` — stable identity, reported when the resource fails to build.
 * - `tag` + `layer` — the canonical Layer providing one or more services.
 *   The `R` channel must include `ScopeOf<S>` so the typed scope brand
 *   gates instantiation.
 * - `scope` — the lifetime, declared at the type level via the literal.
 * - `start` / `stop` — optional startup + shutdown effects.
 *   `stop` is `Effect<void, never, A>` per Effect finalizer contract — it
 *   may not fail (failures are not propagated through scope teardown).
 * - `runtime` — explicit runtime slots for long-lived behavior that reacts
 *   to turns/messages or enriches tool results without going through a
 *   string-keyed middleware registry.
 *
 * Authors typically create a Resource through the smart constructor
 * `defineResource(...)`. The `tag` is the canonical entry into the service
 * the Resource provides; consumers depend on the tag, not on Resource.
 */
interface ResourceContribution<A, S extends ResourceScope, R = never, E = never, StartR = never> {
  readonly id: ResourceId
  /**
   * Optional canonical service tag. When present, consumers may depend on the
   * tag without knowing about Resource. The `start`/`stop` effects get `A`
   * in their R channel so they can read the owned service.
   *
   * When absent, the Resource is a pure layer contribution (the `layer` may
   * provide multiple services via `Layer.merge(...)`), and the lifecycle
   * effects have `A = never` in their R channel.
   *
   * Effect v4 `Context.Service<Identity, Service>` produces a tag whose
   * identity (`A`) and service interface differ; this is why we use the
   * 2-parameter `Context.Key<I, S>` shape instead of the 1-parameter
   * `Context.Tag<A>` shape.
   */
  readonly tag?: Context.Key<A, unknown>
  readonly scope: S
  readonly layer: Layer.Layer<A, E, R | ScopeOf<S>>
  readonly start?: Effect.Effect<void, E, A | R | StartR>
  readonly stop?: Effect.Effect<void, never, A>
}

/**
 * Heterogeneous Resource type — used in arrays where the Resource set
 * spans multiple service tags + R/E channels. Hosts iterate this shape and
 * route each Resource to the appropriate engine.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
export type AnyResourceContribution = ResourceContribution<any, ResourceScope, any, any, any>

interface ResourceIdentitySpec {
  /** Stable resource identity. */
  readonly id: string
}

// ── Smart constructor ──

/**
 * Spec type accepted by {@link defineResource}. Uses `NoInfer` on the
 * `tag` field so the identity `A` is inferred from `layer` only — passing
 * a tag for a different service identity is then a type error rather
 * than a silent unification of `A` to a union supertype.
 */
interface ResourceSpec<
  A,
  S extends ResourceScope,
  R = never,
  E = never,
  StartR = never,
> extends ResourceIdentitySpec {
  readonly tag?: Context.Key<NoInfer<A>, unknown>
  readonly scope: S
  readonly layer: Layer.Layer<A, E, R | ScopeOf<S>>
  /**
   * `StartR` is the additional services `start` may yield beyond the
   * resource's own service `A` and the layer's `R`. Useful when the
   * lifecycle action needs runtime services provided by sibling base
   * layers without forcing the resource's layer
   * itself to depend on them.
   */
  readonly start?: Effect.Effect<void, E, NoInfer<A> | R | StartR>
  readonly stop?: Effect.Effect<void, never, NoInfer<A>>
}

/**
 * Author-facing factory for a {@link ResourceContribution}.
 *
 * The factory infers the generics from the inputs (so authors don't write
 * `<MyService, "process", never, never>`) and brands the resource id.
 *
 * Identity `A` is inferred from `layer`. The `tag` field, if present, is
 * typed as `Context.Key<NoInfer<A>, unknown>` — it must match the layer's
 * identity exactly. Passing a tag for a different service is a type error.
 */
export const defineResource = <A, S extends ResourceScope, R = never, E = never, StartR = never>(
  spec: ResourceSpec<A, S, R, E, StartR>,
): ResourceContribution<A, S, R, E, StartR> => {
  const { id, ...resource } = spec
  return { ...resource, id: ResourceId.make(id) }
}
