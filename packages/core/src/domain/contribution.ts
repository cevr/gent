/**
 * Contribution buckets — typed sub-arrays for `defineExtension`.
 *
 * C8: the legacy `Contribution` discriminated union is gone. Extensions now
 * declare their leaf values in homogeneously-typed buckets. The bucket name
 * IS the discrimination — no `_kind` field on leaves, no wrapper smart
 * constructors, no `filterByKind`.
 *
 * Smart constructors (`tool`, `query`, `mutation`, `agent`, etc.) lower
 * legacy domain shapes (`AnyToolDefinition`, `AnyQueryContribution`,
 * `AgentDefinition`, …) into the leaf type the bucket expects. They are
 * identity-or-near-identity functions that anchor the public API surface
 * and absorb any internal-shape changes.
 *
 * Codex BLOCK on C8 design: drivers split into `modelDrivers` and
 * `externalDrivers` — one untagged `drivers: []` would smuggle back the
 * ambiguity C7's correlated union fixed.
 *
 * @module
 */
import type { AgentDefinition } from "./agent.js"
import type { AnyCapabilityContribution } from "./capability.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "./driver.js"
import type { AnyPipelineContribution, PipelineContribution, PipelineKey } from "./pipeline.js"
import type { AnyProjectionContribution } from "./projection.js"
import type { AnyResourceContribution, ResourceContribution, ResourceScope } from "./resource.js"
import type {
  AnySubscriptionContribution,
  SubscriptionContribution,
  SubscriptionKey,
} from "./subscription.js"

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
  readonly capabilities?: ReadonlyArray<AnyCapabilityContribution>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly projections?: ReadonlyArray<AnyProjectionContribution>
  readonly pipelines?: ReadonlyArray<AnyPipelineContribution>
  readonly subscriptions?: ReadonlyArray<AnySubscriptionContribution>
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
  readonly pulseTags?: ReadonlyArray<string>
}

// ── Smart constructors ──
//
// `pipeline`, `subscription`, `resource` lower their typed authoring
// shape to the bucket leaf. The legacy `tool` / `query` / `mutation`
// smart constructors were deleted in B11.5d — capabilities are now
// authored exclusively through the typed factories in
// `domain/capability/{tool,request,action}.ts`.

/**
 * Identity smart constructor for the Pipeline primitive. Generic over
 * `<K, E, R>` so authors keep their typed handler shape; the leaf is
 * widened to `AnyPipelineContribution` at the bucket boundary.
 */
export const pipeline = <K extends PipelineKey, E, R>(
  p: PipelineContribution<K, E, R>,
): AnyPipelineContribution =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  p as unknown as AnyPipelineContribution

/**
 * Identity smart constructor for the Subscription primitive. Generic over
 * `<K, E, R>` so authors keep their typed handler shape; the leaf is
 * widened to `AnySubscriptionContribution` at the bucket boundary.
 */
export const subscription = <K extends SubscriptionKey, E, R>(
  s: SubscriptionContribution<K, E, R>,
): AnySubscriptionContribution =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  s as unknown as AnySubscriptionContribution

// `query` and `mutation` smart constructors deleted in B11.5d. Authors
// use the unified `request({ intent: "read" | "write", ... })` factory
// at `domain/capability/request.ts`. The internal `QueryContribution`
// and `MutationContribution` interfaces remain for the registry-side
// dispatch but are no longer authored directly.

// `defineResource` is exported directly from `./resource.ts` — returns the
// Resource leaf that goes straight into the `resources` bucket. After C8 it
// no longer sets a `_kind: "resource"` field; the bucket IS the discrimination.
export { defineResource } from "./resource.js"

/**
 * Identity smart constructor for the Resource primitive. Generic over
 * `<A, S, R, E>` so authors keep their typed Resource shape; the leaf is
 * widened to `AnyResourceContribution` at the bucket boundary. Mirrors
 * {@link pipeline} and {@link subscription} — the same variance hole that
 * forces those wideners forces this one too: `Layer.Layer<A, E, R>` has a
 * contravariant `R` channel, so a narrowly-typed `Layer<never, never, ...>`
 * is not assignable to `Layer<any, any, any>` without an identity widener.
 */
export const resource = <A, S extends ResourceScope, R, E>(
  r: ResourceContribution<A, S, R, E>,
): AnyResourceContribution =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  r as unknown as AnyResourceContribution
