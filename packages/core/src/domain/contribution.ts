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
import type { AnyMutationContribution } from "./mutation.js"
import type { AnyPipelineContribution, PipelineContribution, PipelineKey } from "./pipeline.js"
import type { AnyProjectionContribution } from "./projection.js"
import type { AnyQueryContribution } from "./query.js"
import type { AnyResourceContribution, ResourceContribution, ResourceScope } from "./resource.js"
import type {
  AnySubscriptionContribution,
  SubscriptionContribution,
  SubscriptionKey,
} from "./subscription.js"
import type { AnyToolDefinition } from "./tool.js"
import { Schema } from "effect"

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
   * on actor transitions directly — see `WorkflowRuntime.publish`).
   *
   * Keep minimal — every tag translates to one pulse per matching event for
   * this extension. Honest set: "events whose occurrence invalidates the
   * extension's snapshot."
   */
  readonly pulseTags?: ReadonlyArray<string>
}

// ── Smart constructors ──
//
// These take the legacy domain shape (today: `AnyToolDefinition`,
// `AnyQueryContribution`, etc.) and lower it to the leaf type the
// corresponding bucket accepts. After C8 they are NOT wrappers — they
// emit the bare leaf, not a `{_kind, ...}` wrapper.

/**
 * Lower a `ToolDefinition` to a `Capability` with `audiences:["model"]`.
 *
 * Intent: all legacy tools lower as `intent: "write"`. `idempotent` is
 * replay-safety (safe to re-run after restart), NOT the read/write
 * discriminator (codex catch on C4.4 — `rename-session.ts` is `idempotent:
 * true` yet mutates session state). Tools that are genuinely read-only
 * should be authored as direct `capability(...)` with `intent: "read"`.
 */
export const tool = (t: AnyToolDefinition): AnyCapabilityContribution => ({
  id: t.name,
  description: t.description,
  audiences: ["model"],
  intent: "write",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  input: t.params as Schema.Schema<unknown>,
  // ToolRunner consumes raw JSON output; the bridge encodes through
  // `Schema.Unknown` (no-op). Tools that need typed-output validation
  // should declare a Capability directly with a non-Unknown `output`.
  output: Schema.Unknown,
  ...(t.resources !== undefined ? { resources: t.resources } : {}),
  ...(t.idempotent !== undefined ? { idempotent: t.idempotent } : {}),
  ...(t.promptSnippet !== undefined ? { promptSnippet: t.promptSnippet } : {}),
  ...(t.promptGuidelines !== undefined ? { promptGuidelines: t.promptGuidelines } : {}),
  ...(t.interactive !== undefined ? { interactive: t.interactive } : {}),
  ...(t.permissionRules !== undefined ? { permissionRules: t.permissionRules } : {}),
  ...(t.prompt !== undefined ? { prompt: t.prompt } : {}),
  // The capability boundary types `effect`'s ctx as ModelCapabilityContext,
  // which structurally extends ToolContext (the wider one). Tools'
  // `execute(params, ctx: ToolContext)` therefore satisfies the capability
  // signature at the contravariant arg.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  effect: t.execute as AnyCapabilityContribution["effect"],
})

/**
 * Identity smart constructor for an agent. After C8 the `agents` bucket
 * accepts `AgentDefinition` directly; this exists for symmetry with the
 * other smart constructors and to anchor the public-API surface.
 */
export const agent = (a: AgentDefinition): AgentDefinition => a

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

/**
 * Identity smart constructor for a model driver. The bucket type
 * (`modelDrivers: ReadonlyArray<ModelDriverContribution>`) is the
 * discrimination — no flavor field needed.
 */
export const modelDriver = (d: ModelDriverContribution): ModelDriverContribution => d

/**
 * Identity smart constructor for an external driver. The bucket type
 * (`externalDrivers: ReadonlyArray<ExternalDriverContribution>`) is the
 * discrimination — no flavor field needed.
 */
export const externalDriver = (d: ExternalDriverContribution): ExternalDriverContribution => d

/**
 * Identity smart constructor for a projection. After C8 the `projections`
 * bucket accepts `AnyProjectionContribution` directly.
 */
export const projection = (p: AnyProjectionContribution): AnyProjectionContribution => p

/**
 * Lower a `QueryContribution` to a `Capability` with
 * `audiences:["agent-protocol"], intent:"read"`. Queries are read-only RPCs
 * invoked by other extensions. Authors continue to call `query(...)`; the
 * lowering happens here.
 */
export const query = (q: AnyQueryContribution): AnyCapabilityContribution => ({
  id: q.id,
  audiences: ["agent-protocol"],
  intent: "read",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  input: q.input as Schema.Schema<unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  output: q.output as Schema.Schema<unknown>,
  // QueryContext is structurally a subset of CapabilityCoreContext; the
  // handler-as-effect cast is sound at the boundary.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  effect: q.handler as AnyCapabilityContribution["effect"],
})

/**
 * Lower a `MutationContribution` to a `Capability` with
 * `audiences:["agent-protocol"], intent:"write"`. Mutations are write RPCs
 * invoked by other extensions.
 */
export const mutation = (m: AnyMutationContribution): AnyCapabilityContribution => ({
  id: m.id,
  audiences: ["agent-protocol"],
  intent: "write",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  input: m.input as Schema.Schema<unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  output: m.output as Schema.Schema<unknown>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  effect: m.handler as AnyCapabilityContribution["effect"],
})

/**
 * Identity smart constructor for the collapsed Capability primitive.
 * Direct-use entry for capabilities that don't fit the `tool`/`query`/
 * `mutation` shape (e.g., `audiences:["transport-public"]`).
 */
export const capability = (c: AnyCapabilityContribution): AnyCapabilityContribution => c

// `defineResource` and `defineLifecycleResource` are exported directly from
// `./resource.ts` — they return Resource leaves that go straight into the
// `resources` bucket. After C8 they no longer set a `_kind: "resource"`
// field; the bucket IS the discrimination.
export { defineResource, defineLifecycleResource } from "./resource.js"

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
