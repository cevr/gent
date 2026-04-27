/**
 * Contribution buckets — typed sub-arrays for `defineExtension`.
 *
 * C8: the legacy `Contribution` discriminated union is gone. Extensions now
 * declare their leaf values in homogeneously-typed buckets. The bucket name
 * IS the discrimination — no `_kind` field on leaves, no wrapper smart
 * constructors, no `filterByKind`.
 *
 * Capabilities (B11.5): authored exclusively through the typed factories
 * `tool({...})` / `request({...})` / `action({...})` at
 * `domain/capability/{tool,request,action}.ts`. The legacy lowering smart
 * constructors `tool` / `request` aliases from the old split were deleted in B11.5d.
 *
 * Resource keeps an identity smart constructor (`resource`) below — it
 * exists to widen variance at the bucket boundary, not to lower a legacy
 * shape.
 *
 * Codex BLOCK on C8 design: drivers split into `modelDrivers` and
 * `externalDrivers` — one untagged `drivers: []` would smuggle back the
 * ambiguity C7's correlated union fixed.
 *
 * @module
 */
import type { Behavior } from "./actor.js"
import type { AgentDefinition } from "./agent.js"
import type { CapabilityToken } from "./capability.js"
import type { AgentEventTag } from "./event.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "./driver.js"
import type { AnyProjectionContribution } from "./projection.js"
import type { AnyResourceContribution, ResourceContribution, ResourceScope } from "./resource.js"

/**
 * Bucket leaf for the `actors` field. The `Behavior` shape is
 * existentially quantified across the message and state type
 * parameters so a bucket can hold heterogeneously-typed behaviors.
 *
 * `M` and `S` use `any` (not `unknown`) because `Behavior.receive` is
 * contravariant in `M` (and `S`) — a `Behavior<unknown, unknown>`
 * is NOT a supertype of `Behavior<MyMsg, MyState>`, since assigning
 * the latter would let a caller invoke `receive(unknownValue)` when
 * the implementation expects `MyMsg`. `any` opts out of variance
 * checking so authors can drop a `Behavior<MyMsg, MyState>` directly
 * into the bucket without an identity widener.
 *
 * The requirements parameter is fixed to `never` at the bucket
 * boundary — the host has no extra services to provide, so
 * behaviors that need additional dependencies must close them at the
 * declaration site (e.g. `pipe(Effect.provide(Layer))`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bucket leaf: contravariant Behavior position requires `any` to avoid forcing every author through an identity widener
export type AnyBehavior = Behavior<any, any, never>

// ── Typed buckets ──

/**
 * The set of buckets an extension may contribute to. Every field is optional;
 * an extension that contributes nothing returns `{}`. Each bucket is
 * homogeneously typed — there is no discriminator, the field name is the
 * discrimination.
 *
 * Driver split: `modelDrivers` / `externalDrivers` are separate buckets. They
 * share `id` (driver registry key) but nothing else, so a single `drivers`
 * bucket would re-introduce the union-shape unsoundness C7's correlated
 * `DriverKindContribution` fixed (codex BLOCK on C8 design).
 */
export interface ExtensionContributions {
  readonly resources?: ReadonlyArray<AnyResourceContribution>
  readonly capabilities?: ReadonlyArray<CapabilityToken>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly actors?: ReadonlyArray<AnyBehavior>
  readonly projections?: ReadonlyArray<AnyProjectionContribution>
  readonly modelDrivers?: ReadonlyArray<ModelDriverContribution>
  readonly externalDrivers?: ReadonlyArray<ExternalDriverContribution>
  /**
   * Event tags that, when published, invalidate this extension's externally-
   * observable state. The EventPublisher emits an `ExtensionStateChanged`
   * pulse for this extension whenever a matching `AgentEvent._tag` lands.
   *
   * Used by query-backed / projection-only extensions whose state is event-
   * driven but not held in a workflow actor (the workflow path emits pulses
   * on actor transitions directly — see `MachineEngine.publish`).
   *
   * Keep minimal — every tag translates to one pulse per matching event for
   * this extension. Honest set: "events whose occurrence invalidates the
   * extension's snapshot."
   */
  readonly pulseTags?: ReadonlyArray<AgentEventTag>
}

// ── Smart constructors ──
//
// `resource` widens the typed authoring shape to the bucket leaf. The
// legacy `tool` / `query` / `mutation` smart constructors were deleted in
// B11.5d — capabilities are now authored exclusively through the typed factories in
// `domain/capability/{tool,request,action}.ts`.

// The old query/mutation smart constructors are gone. Authors use the
// unified `request({ intent: "read" | "write", ... })` factory at
// `domain/capability/request.ts`.

// `defineResource` is exported directly from `./resource.ts` — returns the
// Resource leaf that goes straight into the `resources` bucket. After C8 it
// no longer sets a `_kind: "resource"` field; the bucket IS the discrimination.
export { defineResource } from "./resource.js"

/**
 * Identity smart constructor for the Resource primitive. Generic over
 * `<A, S, R, E>` so authors keep their typed Resource shape; the leaf is
 * widened to `AnyResourceContribution` at the bucket boundary. The same
 * variance hole that forces this widener exists because `Layer.Layer<A, E, R>` has a
 * contravariant `R` channel, so a narrowly-typed `Layer<never, never, ...>`
 * is not assignable to `Layer<any, any, any>` without an identity widener.
 */
export const resource = <A, S extends ResourceScope, R, E>(
  r: ResourceContribution<A, S, R, E>,
): AnyResourceContribution =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
  r as unknown as AnyResourceContribution
