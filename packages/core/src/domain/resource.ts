/**
 * Resource — long-lived state with explicit scope.
 *
 * Will replace 5 single-purpose contribution kinds (`layer`, `lifecycle`,
 * `bus-subscription`, `job`, `workflow.machine`) with one primitive that
 * carries the unifying concept: "this extension owns a long-lived service
 * with optional periodic work, optional pub/sub subscriptions, optional
 * startup/shutdown, and optionally an internal state machine."
 *
 * Sequencing per `migrate-callers-then-delete-legacy-apis`:
 *   - C3.1 (here): scaffolding — Resource shape + 3 engines (lifecycle /
 *     subscription / schedule), legacy kinds untouched.
 *   - C3.2: migrate `layerContribution` callers → defineResource.
 *   - C3.3: migrate `jobContribution` callers → defineResource.schedule.
 *   - C3.4: migrate `lifecycle` callers → defineResource.start/stop.
 *   - C3.5: add `Resource.machine` + machine engine; migrate `workflow.machine`.
 *   - C3.6: delete `bus-subscription` (no production users).
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
import type { BranchId, SessionId } from "./ids.js"
import type { CwdScope, EphemeralScope, ServerScope } from "../runtime/scope-brands.js"

// ── Bus envelope (shared with subscription handlers) ──

/**
 * The shape pub/sub handlers receive. Channel string identifies the topic
 * (`"agent:<EventTag>"` for auto-published agent events, or
 * `"<extensionId>:<channel>"` for extension-targeted side effects).
 */
export interface ResourceBusEnvelope {
  readonly channel: string
  readonly payload: unknown
  readonly sessionId?: SessionId
  readonly branchId?: BranchId
}

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

// ── Subscription + schedule sub-shapes ──

/**
 * One pub/sub subscription. Multiple subscriptions per Resource are allowed.
 * Pattern: exact channel match, or `"<prefix>:*"` wildcard (matches all
 * `"<prefix>:<rest>"` channels). Errors caught per-handler — a failing
 * handler does not affect other subscribers.
 *
 * Handler `R` is `never` at the engine boundary. This matches the legacy
 * `BusHandler` contract: handlers that need their owning Resource's
 * service `A` must close over `A` themselves (typically by composing the
 * subscription handler inside an `Effect.gen` that yields the tag and
 * captures the resolved value before passing the closure to
 * `defineResource`). Authoring the handler with an open `R` channel and
 * relying on the engine to provide it is unsupported — subscriptions live
 * on the SubscriptionEngine layer, not on per-Resource layers, so the
 * engine cannot satisfy per-Resource requirements at emit time.
 *
 * The `Resource.layer` is the right place to provide `A`: subscriptions
 * defined inside a `Layer.scopedDiscard` that yields `A` and registers
 * pre-bound handlers will get `A` for free. C3.6 may revisit this once
 * real call sites exist.
 */
export interface ResourceSubscription {
  readonly pattern: string
  readonly handler: (envelope: ResourceBusEnvelope) => Effect.Effect<void>
}

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
  readonly id: string
  readonly cron: string
  readonly target: {
    readonly kind: "headless-agent"
    readonly agent: string
    readonly prompt: string
    readonly cwd?: string
  }
}

// ── The Resource contribution ──
//
// NOTE: the `machine` sub-shape is intentionally absent from C3.1.
// `WorkflowContribution.machine` migrates to `Resource.machine` in a later
// commit alongside the actor-supervision engine port. C3.1 establishes the
// Resource shape + 3 engines (lifecycle / subscription / schedule); C3.5
// adds the machine engine and `Resource.machine`.

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
 * - `subscriptions` — pub/sub handlers registered at install time. Replaces
 *   `BusSubscriptionContribution`.
 * - `schedule` — periodic jobs registered at install time. Replaces
 *   `JobContribution`.
 *
 * The `machine` sub-shape (replacing `WorkflowContribution.machine`) is
 * deferred to C3.5 so the simpler engines can ship + be validated first.
 *
 * Authors typically create a Resource through the smart constructor
 * `defineResource(...)`. The `tag` is the canonical entry into the service
 * the Resource provides; consumers depend on the tag, not on Resource.
 */
export interface ResourceContribution<A, S extends ResourceScope, R = never, E = never> {
  readonly _kind: "resource"
  /**
   * Optional canonical service tag. When present, consumers may depend on the
   * tag without knowing about Resource. The `start`/`stop`/`subscriptions`
   * effects get `A` in their R channel so they can read the owned service.
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
  readonly start?: Effect.Effect<void, E, A | R>
  readonly stop?: Effect.Effect<void, never, A>
  readonly subscriptions?: ReadonlyArray<ResourceSubscription>
  readonly schedule?: ReadonlyArray<ResourceSchedule>
}

/**
 * Heterogeneous Resource type — used in arrays where the Resource set
 * spans multiple service tags + R/E channels. Hosts iterate this shape and
 * route each Resource to the appropriate engine.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyResourceContribution = ResourceContribution<any, ResourceScope, any, any>

// ── Smart constructor ──

/**
 * Author-facing factory for a {@link ResourceContribution}.
 *
 * The factory is identity at runtime — its purpose is to (a) infer the
 * generics from the inputs (so authors don't write `<MyService, "session", never, never>`)
 * and (b) anchor the public API surface so future shape changes have one
 * call site to migrate.
 */
export const defineResource = <A, S extends ResourceScope, R = never, E = never>(
  spec: Omit<ResourceContribution<A, S, R, E>, "_kind">,
): ResourceContribution<A, S, R, E> => ({ _kind: "resource", ...spec })
