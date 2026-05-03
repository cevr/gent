/**
 * Contribution buckets — typed sub-arrays for `defineExtension`.
 *
 * Extensions declare their leaf values in homogeneously typed buckets. The
 * bucket name IS the discrimination — no `_kind` field on leaves, no wrapper
 * smart constructors, no `filterByKind`.
 *
 * Capabilities are authored through the typed factories `tool({...})`,
 * `request({...})`, and `action({...})` at
 * `domain/capability/{tool,request,action}.ts`.
 *
 * Resource keeps an identity smart constructor (`resource`) below — it
 * exists to widen variance at the bucket boundary, not to lower a legacy
 * shape.
 *
 * Codex BLOCK on  design: drivers split into `modelDrivers` and
 * `externalDrivers` — one untagged `drivers: []` would smuggle back the
 * ambiguity 's correlated union fixed.
 *
 * @module
 */
import type { AgentDefinition } from "./agent.js"
import type { ActionToken } from "./capability/action.js"
import type { RequestToken } from "./capability/request.js"
import type { ToolToken } from "./capability/tool.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "./driver.js"
import type { AnyResourceContribution, ResourceContribution, ResourceScope } from "./resource.js"
import type { ExtensionReactions as ExtensionReactionsType } from "./extension.js"

/**
 * Re-export for the bucket boundary. The native definition lives in
 * `domain/extension.ts` next to the lifecycle inputs the reactions consume.
 * Erased to `unknown`/`unknown` at the bucket leaf — handlers close their
 * own E/R at the declaration site (e.g. `Effect.provide(Layer)`).
 */
export type ExtensionReactions = ExtensionReactionsType<unknown, unknown>

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
  /**
   * LLM-callable tools authored via `tool({...})`. Bucket name IS the
   * dispatch surface: every entry is a `ToolToken` — no runtime tag check
   * needed downstream.
   */
  readonly tools?: ReadonlyArray<ToolToken>
  /**
   * Human-driven UI commands authored via `action({...})`. Bucket name IS the
   * dispatch surface: every entry is an `ActionToken` — no runtime tag check
   * needed downstream.
   */
  readonly commands?: ReadonlyArray<ActionToken>
  /**
   * Extension-to-extension RPC capabilities authored via `request({...})`.
   * Bucket name IS the dispatch surface: every entry is a `RequestToken` — no
   * runtime tag check needed downstream.
   */
  readonly rpc?: ReadonlyArray<RequestToken>
  readonly agents?: ReadonlyArray<AgentDefinition>
  /**
   * Lifecycle reactions: turn-before / turn-after / message-output /
   * tool-result handlers. Per-extension, per-session — fired by the runtime
   * at the corresponding seams. Compiled by `compileExtensionReactions`.
   */
  readonly reactions?: ExtensionReactions
  readonly modelDrivers?: ReadonlyArray<ModelDriverContribution>
  readonly externalDrivers?: ReadonlyArray<ExternalDriverContribution>
}

// ── Bucket readers ──

/**
 * Read all model-callable capabilities from a contributions bag. Bucket name
 * IS the dispatch discrimination — every entry in `tools:` is a tool leaf by
 * construction.
 */
export const modelCapabilities = (contribs: ExtensionContributions): ReadonlyArray<ToolToken> =>
  contribs.tools ?? []

/**
 * Read all human-surface capabilities (slash / palette) from a contributions
 * bag. Bucket name IS the dispatch discrimination — every entry in
 * `commands:` is an action leaf by construction.
 */
export const humanCapabilities = (contribs: ExtensionContributions): ReadonlyArray<ActionToken> =>
  contribs.commands ?? []

/**
 * Read all extension-to-extension RPC capabilities from a contributions bag.
 * Bucket name IS the dispatch discrimination — every entry in `rpc:` is a
 * request leaf by construction.
 */
export const rpcCapabilities = (contribs: ExtensionContributions): ReadonlyArray<RequestToken> =>
  contribs.rpc ?? []

// ── Smart constructors ──
//
// `resource` widens the typed authoring shape to the bucket leaf. Capabilities
// are authored through the typed factories in `domain/capability/{tool,request,action}.ts`.

// The old query/mutation smart constructors are gone. Authors use the
// unified `request({ intent: "read" | "write", ... })` factory at
// `domain/capability/request.ts`.

// `defineResource` is exported directly from `./resource.ts` — returns the
// Resource leaf that goes straight into the `resources` bucket. After  it
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
