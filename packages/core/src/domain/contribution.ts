/**
 * Contribution buckets — typed sub-arrays for `defineExtension`.
 *
 * Extensions declare their leaf values in homogeneously typed buckets. The
 * bucket name IS the discrimination — no `_kind` field on leaves, no wrapper
 * smart constructors, no `filterByKind`.
 *
 * Capabilities are authored through the typed factories `tool({...})` and
 * `request({...})` at `domain/capability/{tool,request}.ts`. Slash commands
 * are requests carrying a `slash:` presentation block.
 *
 * Resources are authored through `defineResource({...})` or
 * `defineStateResource({...})` from `./resource.ts`. Each leaf carries an
 * explicit stable resource identity and graph metadata; the leaf is widened
 * by structural assignability at the bucket boundary.
 *
 * Drivers split into `modelDrivers` and `externalDrivers`; one untagged
 * `drivers: []` bucket would erase the correlated union.
 *
 * @module
 */
import type { AgentDefinition } from "./agent.js"
import type { RequestCapability } from "./capability/request.js"
import type { ToolCapability } from "./capability/tool.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "./driver.js"
import type { AnyResourceContribution } from "./resource.js"
import type { ScheduledJobContribution } from "./scheduled-job.js"
import type { AnyExtensionHook } from "./extension.js"

// ── Typed buckets ──

/**
 * The set of buckets an extension may contribute to. Every field is optional;
 * an extension that contributes nothing returns `{}`. Each bucket is
 * homogeneously typed — there is no discriminator, the field name is the
 * discrimination.
 *
 * Driver split: `modelDrivers` / `externalDrivers` are separate buckets. They
 * share `id` (driver registry key) but nothing else, so a single `drivers`
 * bucket would re-introduce the union-shape unsoundness that the correlated
 * `DriverKindContribution` fixed.
 */
export interface ExtensionContributions {
  readonly resources?: ReadonlyArray<AnyResourceContribution>
  readonly scheduledJobs?: ReadonlyArray<ScheduledJobContribution>
  /**
   * LLM-callable tools authored via `tool({...})`. Bucket name IS the
   * dispatch surface: every entry is a `ToolCapability` — no runtime tag check
   * needed downstream.
   */
  readonly tools?: ReadonlyArray<ToolCapability>
  /**
   * Extension-to-extension RPC capabilities authored via `request({...})`.
   * Bucket name IS the dispatch surface: every entry is a `RequestCapability` — no
   * runtime tag check needed downstream. Slash commands are requests carrying
   * a `slash:` presentation block.
   */
  readonly requests?: ReadonlyArray<RequestCapability>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly hooks?: ReadonlyArray<AnyExtensionHook>
  readonly modelDrivers?: ReadonlyArray<ModelDriverContribution>
  readonly externalDrivers?: ReadonlyArray<ExternalDriverContribution>
}

// ── Bucket readers ──

/**
 * Read all model-callable capabilities from a contributions bag. Bucket name
 * IS the dispatch discrimination — every entry in `tools:` is a tool leaf by
 * construction.
 */
export const modelCapabilities = (
  contribs: ExtensionContributions,
): ReadonlyArray<ToolCapability> => contribs.tools ?? []

/**
 * Read all extension-to-extension RPC capabilities from a contributions bag.
 * Bucket name IS the dispatch discrimination — every entry in `requests:` is a
 * request leaf by construction.
 */
export const rpcCapabilities = (
  contribs: ExtensionContributions,
): ReadonlyArray<RequestCapability> => contribs.requests ?? []

// ── Smart constructors ──
//
// Capabilities are authored through the typed factories in
// `domain/capability/{tool,request}.ts`. The Resource primitive is authored
// through `defineResource({...})` directly — leaves widen to
// `AnyResourceContribution` by structural assignability when the `layer`'s
// `A` is concrete (not `never`). `defineStateResource({...})` lowers a
// state cell to that same Resource primitive. Lifecycle-only resources should
// encode disposal as a `Layer.scoped` finalizer over a marker tag rather than
// `{ layer: Layer.empty, stop: ... }`.
export { defineResource, defineStateResource } from "./resource.js"
export type { ExtensionState, StateInitializer, StateResourceSpec } from "./resource.js"
export { ResourceId, ResourceRevision } from "./resource-graph.js"
