/**
 * Resource — long-lived state with explicit scope.
 *
 * Replaces single-purpose contribution kinds (`layer`, `lifecycle`,
 * `job`, `workflow.machine`) with one primitive that
 * carries the unifying concept: "this extension owns a long-lived service
 * with optional periodic work and optional startup/shutdown."
 *
 * The `scope` discriminator is the load-bearing addition over the legacy
 * kinds — every Resource declares its lifetime as one of:
 *
 *   - `"process"`  — survives for the server's lifetime; requires `ServerScope`
 *   - `"cwd"`      — survives per-cwd; requires `CwdScope`
 *   - `"session"`  — survives per-session; requires `EphemeralScope`
 *   - `"branch"`   — survives per-branch; requires `EphemeralScope`
 *
 * The `ScopeOf<S>` mapped type threads the runtime literal into the type
 * level, so the host can route `scope: "session"` Resources to the
 * ephemeral install path and refuse to install them at process scope.
 *
 * @module
 */

import type { Context, Effect, Layer } from "effect"
import type { AgentName } from "./agent.js"
import type { CwdScope, EphemeralScope, ServerScope } from "./scope-brand.js"

// ── Scope discriminator + brand mapping ──

/** Runtime literal-string union for Resource lifetimes. */
export type ResourceScope = "process" | "cwd" | "session" | "branch"

/**
 * Type-level mapping from the `scope` literal to the corresponding nominal
 * scope brand. The brand flows into the `R` channel of the Resource's
 * `layer`, so a `scope: "session"` Resource cannot be instantiated at
 * process scope (the brand types do not unify).
 */
export type ScopeOf<S extends ResourceScope> = S extends "process"
  ? ServerScope
  : S extends "cwd"
    ? CwdScope
    : EphemeralScope

// ── Schedule sub-shape ──

/**
 * One scheduled job. `cron` is a standard cron expression (consumed by
 * `Bun.cron`). The host installs the job at process startup; `target`
 * describes the headless-agent invocation to spawn on each tick.
 *
 * Today's sole job type is `"headless-agent"` — the scheduler renders a
 * wrapper script that invokes `gent --headless --agent <agent> <prompt>`
 * and registers the script with the OS-level cron daemon.
 */
export interface ResourceSchedule {
  /** Extension-local id. Host namespaces with extension id when installing. */
  readonly id: string
  /** Standard cron expression — consumed by `Bun.cron`. */
  readonly cron: string
  readonly target: {
    readonly agent: AgentName
    readonly prompt: string
    readonly cwd?: string
  }
}

// ── The Resource contribution ──

/**
 * One Resource carries:
 *
 * - `tag` + `layer` — the canonical Layer providing one or more services.
 *   The `R` channel must include `ScopeOf<S>` so the typed scope brand
 *   gates instantiation.
 * - `scope` — the lifetime, declared at the type level via the literal.
 * - `start` / `stop` — optional startup + shutdown effects. Replaces the
 *   `LifecycleContribution` `phase: "startup" | "shutdown"` discriminator.
 *   `stop` is `Effect<void, never, A>` per Effect finalizer contract — it
 *   may not fail (failures are not propagated through scope teardown).
 * - `schedule` — periodic jobs reconciled at host startup. Replaces the
 *   legacy `JobContribution` + `scheduler.ts` reconciliation pair.
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
  readonly schedule?: ReadonlyArray<ResourceSchedule>
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
   * layers (e.g. `ActorEngine`) without forcing the resource's layer
   * itself to depend on them.
   */
  readonly start?: Effect.Effect<void, E, NoInfer<A> | R | StartR>
  readonly stop?: Effect.Effect<void, never, NoInfer<A>>
  readonly schedule?: ReadonlyArray<ResourceSchedule>
}

/**
 * Author-facing factory for a {@link ResourceContribution}.
 *
 * The factory is identity at runtime — its purpose is to (a) infer the
 * generics from the inputs (so authors don't write `<MyService, "session", never, never>`)
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
