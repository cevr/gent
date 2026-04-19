/**
 * Contribution union — the foundational data structure for extension authoring.
 *
 * Every extension reduces to a flat array of `Contribution` values. This is the
 * canonical authoring shape — `defineExtension({ id, contributions })` lowers
 * the array into the runtime `ExtensionSetup` consumed by the registry.
 *
 * The discriminator is `_kind`. New kinds are added by extending the union, not
 * by adding fields to a setup bag.
 *
 * @module
 */
import type { AgentDefinition } from "./agent.js"
import type { AnyCapabilityContribution } from "./capability.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "./driver.js"
import type { CommandContribution } from "./extension.js"
import type { PermissionRule } from "./permission.js"
import type { DynamicPromptSection, PromptSection, PromptSectionInput } from "./prompt.js"
import type { AnyMutationContribution } from "./mutation.js"
import type { AnyPipelineContribution, PipelineContribution, PipelineKey } from "./pipeline.js"
import type { AnyProjectionContribution } from "./projection.js"
import type { AnyQueryContribution } from "./query.js"
import type { AnyResourceContribution, AnyResourceMachine } from "./resource.js"
import type {
  AnySubscriptionContribution,
  SubscriptionContribution,
  SubscriptionKey,
} from "./subscription.js"
import type { AnyToolDefinition } from "./tool.js"
import { Schema } from "effect"

// ── Per-kind contribution shapes ──

export interface AgentContribution {
  readonly _kind: "agent"
  readonly agent: AgentDefinition
}

/**
 * Pipeline — transforming middleware with a real `next` and a meaningful
 * (non-void) return type. Six hooks: `prompt.system`, `tool.execute`,
 * `permission.check`, `context.messages`, `tool.result`, `message.input`.
 *
 * Sister kind: `SubscriptionKindContribution` for void observers. C6 split
 * the legacy `Interceptor<I, O>` shape into Pipeline (transformer) +
 * Subscription (observer) — `Interceptor<I, void>` was a deceptive shape
 * where `next` was bookkeeping (codex C6 correction).
 */
export interface PipelineKindContribution {
  readonly _kind: "pipeline"
  readonly pipeline: AnyPipelineContribution
}

/**
 * Subscription — ordered void observer with declared failure policy. Three
 * hooks: `turn.before`, `turn.after`, `message.output`. Each subscription
 * declares `failureMode: "continue" | "isolate" | "halt"`.
 */
export interface SubscriptionKindContribution {
  readonly _kind: "subscription"
  readonly subscription: AnySubscriptionContribution
}

export interface CommandKindContribution {
  readonly _kind: "command"
  readonly command: CommandContribution
}

export interface ModelDriverKindContribution {
  readonly _kind: "model-driver"
  readonly driver: ModelDriverContribution
}

export interface ExternalDriverKindContribution {
  readonly _kind: "external-driver"
  readonly driver: ExternalDriverContribution
}

export interface PermissionRuleContribution {
  readonly _kind: "permission-rule"
  readonly rule: PermissionRule
}

export interface PromptSectionContribution {
  readonly _kind: "prompt-section"
  readonly section: PromptSectionInput
}

export interface ProjectionKindContribution {
  readonly _kind: "projection"
  readonly projection: AnyProjectionContribution
}

/**
 * Capability — typed callable endpoint shared by tool/query/mutation/command
 * (collapsed under one ontology in C4). Smart constructors for the legacy
 * names continue to exist (`tool`, `query`, `mutation`, `command`); they will
 * progressively emit `CapabilityKindContribution` underneath as C4.2/3/4 land.
 *
 * Self-discrimination via `audiences` (who may invoke) + `intent` (read/write).
 */
export interface CapabilityKindContribution {
  readonly _kind: "capability"
  readonly capability: AnyCapabilityContribution
}

/**
 * Declares that the contributing extension's externally-observable state
 * changes when any of these `AgentEvent._tag`s is published. The
 * EventPublisher emits an `ExtensionStateChanged` pulse for this extension
 * whenever a matching event lands. This is the bridge for query-backed /
 * projection-only extensions whose state is event-driven but not held in a
 * workflow actor (the workflow path emits pulses on actor transitions
 * directly — see `WorkflowRuntime.publish`).
 *
 * Keep `tags` minimal — every tag in the list translates to one pulse per
 * matching event for this extension. The honest set is "events whose
 * occurrence invalidates the extension's snapshot."
 */
export interface PulseSubscriptionContribution {
  readonly _kind: "pulse-subscription"
  readonly tags: ReadonlyArray<string>
}

// ── Union ──

export type Contribution =
  | AgentContribution
  | PipelineKindContribution
  | SubscriptionKindContribution
  | CommandKindContribution
  | ModelDriverKindContribution
  | ExternalDriverKindContribution
  | PermissionRuleContribution
  | PromptSectionContribution
  | ProjectionKindContribution
  | CapabilityKindContribution
  | PulseSubscriptionContribution
  | AnyResourceContribution

export type ContributionKind = Contribution["_kind"]

// ── Smart constructors ──

/**
 * C4.4 — `tool(...)` lowers into a `Capability(audiences:["model"])` rather
 * than the legacy `ToolContribution`. Authors continue to write
 * `defineTool({...})` and `toolContribution(myTool)`; the contribution kind
 * surfacing in `LoadedExtension.contributions` is now `"capability"`. The
 * registry's tool-bridge (`capabilityToTool`) re-projects it for `ToolRunner`
 * until C4.5 deletes the legacy `ToolDefinition` type entirely.
 *
 * Intent: all legacy tools lower as `intent: "write"`. Codex caught the
 * earlier `idempotent ⇒ "read"` derivation as a lie — `idempotent` is
 * replay-safety (safe to re-run after restart), NOT the read/write
 * discriminator. Counterexample: `rename-session.ts` is `idempotent: true`
 * yet mutates session state via `ctx.session.renameCurrent(...)`. Tools
 * that are genuinely read-only should be authored as direct
 * `capabilityContribution(...)` with `intent: "read"` and a narrow context
 * (the lint rule fences write services on `R` of read capabilities).
 * `idempotent` flows through unchanged as model-audience metadata.
 */
const toolToCapability = (t: AnyToolDefinition): AnyCapabilityContribution => ({
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
  // The capability boundary types `effect`'s ctx as ModelCapabilityContext,
  // which structurally extends ToolContext (the wider one). Tools'
  // `execute(params, ctx: ToolContext)` therefore satisfies the capability
  // signature at the contravariant arg.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at the tool→capability boundary
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  effect: t.execute as AnyCapabilityContribution["effect"],
})

export const tool = (t: AnyToolDefinition): CapabilityKindContribution => ({
  _kind: "capability",
  capability: toolToCapability(t),
})

export const agent = (a: AgentDefinition): AgentContribution => ({ _kind: "agent", agent: a })

/**
 * Smart constructor for the Pipeline primitive (transformer with `next`).
 * Six hooks; output type ≠ void. See `pipeline.ts` for the full key map.
 *
 * Generic over `K, E, R` so authors keep their typed handler shape; the
 * contribution's `R`/`E` is provided by the extension's Resource layer at
 * composition time, then erased into the union shape.
 */
export const pipeline = <K extends PipelineKey, E, R>(
  p: PipelineContribution<K, E, R>,
): PipelineKindContribution => ({
  _kind: "pipeline",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  pipeline: p as unknown as AnyPipelineContribution,
})

/**
 * Smart constructor for the Subscription primitive (ordered void observer).
 * Three hooks: `turn.before`, `turn.after`, `message.output`. Each
 * subscription declares a `failureMode`.
 */
export const subscription = <K extends SubscriptionKey, E, R>(
  s: SubscriptionContribution<K, E, R>,
): SubscriptionKindContribution => ({
  _kind: "subscription",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  subscription: s as unknown as AnySubscriptionContribution,
})

export const command = (c: CommandContribution): CommandKindContribution => ({
  _kind: "command",
  command: c,
})

export const modelDriver = (d: ModelDriverContribution): ModelDriverKindContribution => ({
  _kind: "model-driver",
  driver: d,
})

export const externalDriver = (d: ExternalDriverContribution): ExternalDriverKindContribution => ({
  _kind: "external-driver",
  driver: d,
})

export const permissionRule = (r: PermissionRule): PermissionRuleContribution => ({
  _kind: "permission-rule",
  rule: r,
})

/**
 * Smart constructor accepts either a static `PromptSection` or a
 * `DynamicPromptSection<R>` for any `R`. The extension's `layerContribution`
 * is responsible for providing `R` at the runtime boundary; the contribution
 * itself stores the section with `R` erased to `never`, mirroring the legacy
 * builder's behavior.
 */
export const promptSection = <R = never>(
  s: PromptSection | DynamicPromptSection<R>,
): PromptSectionContribution => ({
  _kind: "prompt-section",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  section: s as PromptSectionInput,
})

export const projection = (p: AnyProjectionContribution): ProjectionKindContribution => ({
  _kind: "projection",
  projection: p,
})

/**
 * Lower a `QueryContribution` to a `CapabilityContribution`. Queries are
 * read-only RPCs invoked by other extensions; the capability equivalent is
 * `audiences: ["agent-protocol"], intent: "read"`. Per the C4.5 deletion,
 * `query()` no longer emits a separate `_kind: "query"` contribution —
 * extension authors keep using `query(...)` and the lowering happens here.
 */
const queryToCapability = (q: AnyQueryContribution): AnyCapabilityContribution => ({
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
 * Lower a `MutationContribution` to a `CapabilityContribution`. Mutations
 * are write RPCs invoked by other extensions; the capability equivalent is
 * `audiences: ["agent-protocol"], intent: "write"`. Same pattern as
 * `queryToCapability`.
 */
const mutationToCapability = (m: AnyMutationContribution): AnyCapabilityContribution => ({
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

export const query = (q: AnyQueryContribution): CapabilityKindContribution => ({
  _kind: "capability",
  capability: queryToCapability(q),
})

export const mutation = (m: AnyMutationContribution): CapabilityKindContribution => ({
  _kind: "capability",
  capability: mutationToCapability(m),
})

/**
 * Smart constructor for the new collapsed Capability primitive. During the
 * C4.2/3/4 migration this is exposed alongside the legacy `tool`/`query`/
 * `mutation`/`command` constructors; once those wrappers are deleted in C4.5
 * this becomes the only direct-use entry (extension authors continue to call
 * the domain-named smart constructors which lower to `capability(...)` under
 * the hood).
 */
export const capability = (c: AnyCapabilityContribution): CapabilityKindContribution => ({
  _kind: "capability",
  capability: c,
})

export const pulseSubscription = (tags: ReadonlyArray<string>): PulseSubscriptionContribution => ({
  _kind: "pulse-subscription",
  tags,
})

// `defineResource` is exported directly from `./resource.ts` — Resources
// self-discriminate via `_kind: "resource"` on the contribution itself,
// so there is no contribution-side wrapper smart constructor here.
export { defineResource, defineLifecycleResource } from "./resource.js"

// ── Filters ──

type ContributionByKind<K extends ContributionKind> = Extract<Contribution, { readonly _kind: K }>

/** Return only contributions of the given kind. */
export const filterByKind = <K extends ContributionKind>(
  contributions: ReadonlyArray<Contribution>,
  kind: K,
): ReadonlyArray<ContributionByKind<K>> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  contributions.filter((c): c is ContributionByKind<K> => c._kind === kind)

/** Find the (at most one) contribution of the given kind, or undefined. */
export const findByKind = <K extends ContributionKind>(
  contributions: ReadonlyArray<Contribution>,
  kind: K,
): ContributionByKind<K> | undefined =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  contributions.find((c): c is ContributionByKind<K> => c._kind === kind)

/**
 * Per-kind extractors that pull the typed payload out of a contribution array.
 * These replace the legacy `ExtensionSetup` setup-bag — registries and runtime
 * code call these directly instead of reading `ext.setup.tools` etc.
 */
export const extractAgents = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<AgentContribution["agent"]> => filterByKind(cs, "agent").map((c) => c.agent)

export const extractPipelines = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<AnyPipelineContribution> => filterByKind(cs, "pipeline").map((c) => c.pipeline)

export const extractSubscriptions = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<AnySubscriptionContribution> =>
  filterByKind(cs, "subscription").map((c) => c.subscription)

export const extractCommands = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<CommandKindContribution["command"]> =>
  filterByKind(cs, "command").map((c) => c.command)

export const extractPromptSections = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<PromptSectionContribution["section"]> =>
  filterByKind(cs, "prompt-section").map((c) => c.section)

export const extractPermissionRules = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<PermissionRuleContribution["rule"]> =>
  filterByKind(cs, "permission-rule").map((c) => c.rule)

export const extractModelDrivers = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<ModelDriverKindContribution["driver"]> =>
  filterByKind(cs, "model-driver").map((c) => c.driver)

export const extractExternalDrivers = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<ExternalDriverKindContribution["driver"]> =>
  filterByKind(cs, "external-driver").map((c) => c.driver)

export const extractProjections = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<ProjectionKindContribution["projection"]> =>
  filterByKind(cs, "projection").map((c) => c.projection)

export const extractCapabilities = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<CapabilityKindContribution["capability"]> =>
  filterByKind(cs, "capability").map((c) => c.capability)

export const extractPulseSubscriptions = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<PulseSubscriptionContribution> => filterByKind(cs, "pulse-subscription")

export const extractResources = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<AnyResourceContribution> => filterByKind(cs, "resource")

/**
 * Returns the machine declared by an extension's contributions — i.e., the
 * first `Resource` that declares a `machine`. Returns `undefined` if no
 * Resource carries a machine.
 */
export const extractMachine = (cs: ReadonlyArray<Contribution>): AnyResourceMachine | undefined =>
  extractResources(cs).find((r) => r.machine !== undefined)?.machine
