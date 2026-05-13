/**
 * Resource — long-lived state with explicit scope.
 *
 * Replaces single-purpose contribution kinds (`layer`, `lifecycle`,
 * `workflow.machine`) with one primitive that
 * carries the unifying concept: "this extension owns a long-lived service
 * with optional startup/shutdown."
 *
 * The `scope` discriminator is intentionally narrow. Today the host owns
 * exactly one long-lived resource lifetime:
 *
 *   - `"process"` — survives for the server's lifetime; requires `ServerScope`
 *
 * Add more scope literals only with their host lifecycle implementation in the
 * same wave. Advertising `session`/`branch`/`cwd` without a runtime owner makes
 * impossible lifetimes look supported.
 *
 * @module
 */

import { Effect, Layer, Ref } from "effect"
import type { Context } from "effect"

// ── Scope discriminator + brand mapping ──

/**
 * Pure type-level scope brand used by Resource declarations. Encodes the
 * lifetime of a `Scope.Scope` at the type level. Today Resource hosting
 * supports only process-scoped services: `ServerScope` survives for the
 * server's lifetime. Add new brands only when their resource host lifecycle
 * exists. These types carry no runtime payload; they are purely structural.
 */
declare const ServerBrand: unique symbol
export type ServerScope = { readonly [ServerBrand]: true }

/** Runtime literal-string union for Resource lifetimes. */
export type ResourceScope = "process"

/**
 * Type-level mapping from the `scope` literal to the corresponding nominal
 * scope brand. The brand flows into the `R` channel of the Resource's `layer`.
 */
export type ScopeOf<S extends ResourceScope> = S extends "process" ? ServerScope : never

// ── The Resource contribution ──

/**
 * One Resource carries:
 *
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
export interface ResourceContribution<
  A,
  S extends ResourceScope,
  R = never,
  E = never,
  StartR = never,
> {
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

// ── Smart constructor ──

/**
 * Spec type accepted by {@link defineResource}. Uses `NoInfer` on the
 * `tag` field so the identity `A` is inferred from `layer` only — passing
 * a tag for a different service identity is then a type error rather
 * than a silent unification of `A` to a union supertype.
 */
export interface ResourceSpec<A, S extends ResourceScope, R = never, E = never, StartR = never> {
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
 * The factory is identity at runtime — its purpose is to (a) infer the
 * generics from the inputs (so authors don't write `<MyService, "process", never, never>`)
 * and (b) anchor the public API surface so future shape changes have one
 * call site to migrate.
 *
 * Identity `A` is inferred from `layer`. The `tag` field, if present, is
 * typed as `Context.Key<NoInfer<A>, unknown>` — it must match the layer's
 * identity exactly. Passing a tag for a different service is a type error.
 */
export const defineResource = <A, S extends ResourceScope, R = never, E = never, StartR = never>(
  spec: ResourceSpec<A, S, R, E, StartR>,
): ResourceContribution<A, S, R, E, StartR> => ({ ...spec })

export interface ExtensionState<Value> {
  readonly get: Effect.Effect<Value>
  readonly set: (value: Value) => Effect.Effect<void>
  readonly update: (f: (current: Value) => Value) => Effect.Effect<void>
  readonly modify: <A>(f: (current: Value) => readonly [A, Value]) => Effect.Effect<A>
}

export type StateInitializer<Value, E = never, R = never> = Value | Effect.Effect<Value, E, R>

export interface StateResourceSpec<A, Value, S extends ResourceScope, R = never, E = never> {
  readonly tag: Context.Key<A, ExtensionState<Value>>
  readonly scope: S
  readonly initial: StateInitializer<Value, E, R>
}

const resolveStateInitial = <Value, E, R>(
  initial: StateInitializer<Value, E, R>,
): Effect.Effect<Value, E, R> => (Effect.isEffect(initial) ? initial : Effect.succeed(initial))

export const defineStateResource = <A, Value, S extends ResourceScope, R = never, E = never>(
  spec: StateResourceSpec<A, Value, S, R, E>,
): ResourceContribution<A, S, R, E> =>
  defineResource({
    tag: spec.tag,
    scope: spec.scope,
    layer: Layer.effect(
      spec.tag,
      Effect.gen(function* () {
        const initial = yield* resolveStateInitial(spec.initial)
        const ref = yield* Ref.make(initial)
        return {
          get: Ref.get(ref),
          set: (value) => Ref.set(ref, value),
          update: (f) => Ref.update(ref, f),
          modify: (f) => Ref.modify(ref, f),
        } satisfies ExtensionState<Value>
      }),
    ),
  })
