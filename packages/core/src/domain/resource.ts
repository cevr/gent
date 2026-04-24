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
 *   - C3.1: scaffolding — Resource shape + SubscriptionEngine; legacy
 *     hosts untouched.
 *   - C3.2: migrate `layerContribution` callers → defineResource.
 *   - C3.3 (here): schedule engine + `defineResource.schedule`; legacy
 *     scheduler.ts and JobContribution deleted.
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

import type { Context, Effect, Layer, Schema } from "effect"
import type { Machine, ProvideSlots, SlotCalls, SlotsDef } from "effect-machine"
import type { AgentName } from "./agent.js"
import type { AgentEvent } from "./event.js"
import type {
  ExtensionEffect,
  MessageOutputInput,
  ToolResultInput,
  TurnAfterInput,
  TurnBeforeInput,
} from "./extension.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
} from "./extension-protocol.js"
import type { ExtensionHostContext } from "./extension-host-context.js"
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

// ── Explicit runtime slots ──

/** Failure policy for explicit Resource-owned runtime reactions. */
export type ResourceReactionFailureMode = "continue" | "isolate" | "halt"

export interface ResourceReaction<Input, E = never, R = never> {
  readonly failureMode: ResourceReactionFailureMode
  readonly handler: (input: Input, ctx: ExtensionHostContext) => Effect.Effect<void, E, R>
}

export interface ResourceRuntimeSlots<E = never, R = never> {
  readonly turnBefore?: ResourceReaction<TurnBeforeInput, E, R>
  readonly turnAfter?: ResourceReaction<TurnAfterInput, E, R>
  readonly messageOutput?: ResourceReaction<MessageOutputInput, E, R>
  /**
   * Explicit tool-result rewrite slot.
   *
   * Replaces the generic `"tool.result"` pipeline for long-lived behaviors
   * that enrich or persist tool results based on resource-owned state.
   * The handler receives the current result and returns the next result.
   */
  readonly toolResult?: (
    input: ToolResultInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<unknown, E, R>
}

// ── The Resource machine sub-shape (C3.5) ──

/** Lifecycle context handed to `onInit`. */
export interface ResourceMachineInitContext<State, Event, SD extends SlotsDef> {
  readonly sessionId: SessionId
  readonly snapshot: Effect.Effect<State>
  readonly send: (event: Event) => Effect.Effect<boolean>
  readonly sessionCwd?: string
  readonly parentSessionId?: SessionId
  readonly getSessionAncestors: () => Effect.Effect<ReadonlyArray<{ readonly id: string }>>
  readonly slots?: SlotCalls<SD>
}

/**
 * Declarative state machine attached to a Resource. Holds the machine
 * definition plus mappers from agent events / extension messages into
 * machine events, plus declared effects that fire after every transition.
 *
 * Type parameters mirror `effect-machine`'s machine: State, Event, optional
 * slot-providing services, optional slot definitions.
 */
export interface ResourceMachine<
  State extends { readonly _tag: string } = { readonly _tag: string },
  Event extends { readonly _tag: string } = { readonly _tag: string },
  SlotsR = never,
  SD extends SlotsDef = Record<string, never>,
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
  readonly machine: Machine.Machine<State, Event, never, any, any, SD>
  readonly slots?: (ctx: {
    readonly sessionId: SessionId
    readonly branchId?: BranchId
  }) => Effect.Effect<ProvideSlots<SD>, never, SlotsR>
  readonly mapEvent?: (event: AgentEvent) => Event | undefined
  readonly mapCommand?: (message: AnyExtensionCommandMessage, state: State) => Event | undefined
  readonly mapRequest?: (message: AnyExtensionRequestMessage, state: State) => Event | undefined
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<ExtensionEffect>
  readonly stateSchema?: Schema.Schema<State>
  readonly protocols?: Readonly<Record<string, unknown>>
  readonly onInit?: (ctx: ResourceMachineInitContext<State, Event, SD>) => Effect.Effect<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
export type AnyResourceMachine = ResourceMachine<any, any, any, any>

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
 * - `subscriptions` — pub/sub handlers registered at install time on the
 *   `SubscriptionEngine` (channel-based exact / `<prefix>:*` wildcard).
 * - `schedule` — periodic jobs reconciled at host startup. Replaces the
 *   legacy `JobContribution` + `scheduler.ts` reconciliation pair.
 * - `machine` — optional state machine + mappers + declared effects.
 *   `MachineEngine` (resource-host/machine-engine.ts) supervises one
 *   actor per session per Resource that declares `machine`.
 * - `runtime` — explicit runtime slots for long-lived behavior that reacts
 *   to turns/messages or enriches tool results without going through a
 *   string-keyed middleware registry.
 *
 * Authors typically create a Resource through the smart constructor
 * `defineResource(...)`. The `tag` is the canonical entry into the service
 * the Resource provides; consumers depend on the tag, not on Resource.
 */
export interface ResourceContribution<A, S extends ResourceScope, R = never, E = never> {
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
  readonly machine?: AnyResourceMachine
  readonly runtime?: ResourceRuntimeSlots<E, A | R>
}

/**
 * Heterogeneous Resource type — used in arrays where the Resource set
 * spans multiple service tags + R/E channels. Hosts iterate this shape and
 * route each Resource to the appropriate engine.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
export type AnyResourceContribution = ResourceContribution<any, ResourceScope, any, any>

// ── Smart constructor ──

/**
 * Spec type accepted by {@link defineResource}. Uses `NoInfer` on the
 * `tag` field so the identity `A` is inferred from `layer` only — passing
 * a tag for a different service identity is then a type error rather
 * than a silent unification of `A` to a union supertype.
 */
export interface ResourceSpec<A, S extends ResourceScope, R = never, E = never> {
  readonly tag?: Context.Key<NoInfer<A>, unknown>
  readonly scope: S
  readonly layer: Layer.Layer<A, E, R | ScopeOf<S>>
  readonly start?: Effect.Effect<void, E, NoInfer<A> | R>
  readonly stop?: Effect.Effect<void, never, NoInfer<A>>
  readonly subscriptions?: ReadonlyArray<ResourceSubscription>
  readonly schedule?: ReadonlyArray<ResourceSchedule>
  readonly machine?: AnyResourceMachine
  readonly runtime?: ResourceRuntimeSlots<E, NoInfer<A> | R>
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
export const defineResource = <A, S extends ResourceScope, R = never, E = never>(
  spec: ResourceSpec<A, S, R, E>,
): ResourceContribution<A, S, R, E> => ({ ...spec })
