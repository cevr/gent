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

/**
 * Bucket leaf for the `actors` field. The `Behavior` shape is
 * existentially quantified across the message and state type
 * parameters so a bucket can hold heterogeneously-typed behaviors.
 *
 * `M` and `S` use `any` (not `unknown`) because `Behavior` is invariant
 * in both: `receive: (msg: M, state: S) => Effect<S>` puts `M` in
 * contravariant position and `S` in both positions. A widener
 * (`unknown`) would force every caller through an identity cast;
 * `any` opts out of variance checking so authors can route behaviors
 * through the typed `behavior()` smart constructor below — which
 * performs the cast in exactly one place.
 *
 * The requirements parameter is fixed to `never` at the bucket
 * boundary — the host has no extra services to provide, so
 * behaviors that need additional dependencies must close them at the
 * declaration site (e.g. `pipe(Effect.provide(Layer))`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bucket leaf: invariant Behavior position; `behavior()` smart constructor below is the named cast site
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
  /**
   * LLM-callable tools authored via `tool({...})`. Bucket name IS the
   * audience: every entry is a `ToolToken` with `audiences: ["model"]`
   * — no runtime tag check needed downstream.
   */
  readonly tools?: ReadonlyArray<ToolToken>
  /**
   * Human-driven UI commands authored via `action({...})`. Bucket name IS the
   * audience cluster: every entry is an `ActionToken` whose `audiences` is a
   * subset of `{"human-slash", "human-palette"}` — no runtime tag check
   * needed downstream.
   */
  readonly commands?: ReadonlyArray<ActionToken>
  /**
   * Extension-to-extension RPC capabilities authored via `request({...})`.
   * Bucket name IS the audience cluster: every entry is a `RequestToken` with
   * `audiences: ["agent-protocol", "transport-public"]` — no runtime tag
   * check needed downstream.
   */
  readonly rpc?: ReadonlyArray<RequestToken>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly actors?: ReadonlyArray<AnyBehavior>
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
 * Read all model-audience capabilities from a contributions bag. Bucket name
 * IS the audience discrimination — every entry in `tools:` has
 * `audiences: ["model"]` by construction.
 */
export const modelCapabilities = (contribs: ExtensionContributions): ReadonlyArray<ToolToken> =>
  contribs.tools ?? []

/**
 * Read all human-surface capabilities (slash / palette) from a contributions
 * bag. Bucket name IS the audience discrimination — every entry in `commands:`
 * has audiences ⊆ `{"human-slash", "human-palette"}` by construction.
 */
export const humanCapabilities = (contribs: ExtensionContributions): ReadonlyArray<ActionToken> =>
  contribs.commands ?? []

/**
 * Read all extension-to-extension RPC capabilities from a contributions bag.
 * Bucket name IS the audience discrimination — every entry in `rpc:` has
 * `audiences: ["agent-protocol", "transport-public"]` by construction.
 */
export const rpcCapabilities = (contribs: ExtensionContributions): ReadonlyArray<RequestToken> =>
  contribs.rpc ?? []

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

/**
 * Identity smart constructor for the Behavior primitive. Generic over
 * `<M, S>` so authors keep their typed Behavior shape; the leaf is
 * widened to `AnyBehavior` at the bucket boundary. The requirements
 * channel is closed to `never` at the boundary — behaviors that need
 * extra services must close them at the declaration site via
 * `Effect.provide`.
 */
export const behavior = <M, S>(b: Behavior<M, S, never>): AnyBehavior =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- bucket boundary: invariant Behavior<M,S> existentially quantified to AnyBehavior
  b as unknown as AnyBehavior
