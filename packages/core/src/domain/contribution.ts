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
import type { CommandContribution, ExtensionInterceptorDescriptor } from "./extension.js"
import type { PermissionRule } from "./permission.js"
import type { DynamicPromptSection, PromptSection, PromptSectionInput } from "./prompt.js"
import type { AnyMutationContribution } from "./mutation.js"
import type { AnyProjectionContribution } from "./projection.js"
import type { AnyQueryContribution } from "./query.js"
import type { AnyResourceContribution, AnyResourceMachine } from "./resource.js"
import type { AnyToolDefinition } from "./tool.js"
import { Schema } from "effect"

// ── Per-kind contribution shapes ──

export interface ToolContribution {
  readonly _kind: "tool"
  readonly tool: AnyToolDefinition
}

export interface AgentContribution {
  readonly _kind: "agent"
  readonly agent: AgentDefinition
}

export interface InterceptorContribution {
  readonly _kind: "interceptor"
  readonly descriptor: ExtensionInterceptorDescriptor
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

export interface QueryKindContribution {
  readonly _kind: "query"
  readonly query: AnyQueryContribution
}

export interface MutationKindContribution {
  readonly _kind: "mutation"
  readonly mutation: AnyMutationContribution
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
  | ToolContribution
  | AgentContribution
  | InterceptorContribution
  | CommandKindContribution
  | ModelDriverKindContribution
  | ExternalDriverKindContribution
  | PermissionRuleContribution
  | PromptSectionContribution
  | ProjectionKindContribution
  | QueryKindContribution
  | MutationKindContribution
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
 * Intent derivation: tools today don't carry a read/write declaration. We
 * default to `intent: "write"` because LLM-invoked tools usually mutate
 * something; tools that opt into `idempotent: true` flip to `intent: "read"`
 * (idempotent ⇒ replayable ⇒ read-shaped — this matches the existing
 * registry-level lint rule that forbids write services in read-only handlers).
 */
const toolToCapability = (t: AnyToolDefinition): AnyCapabilityContribution => ({
  id: t.name,
  description: t.description,
  audiences: ["model"],
  intent: t.idempotent === true ? "read" : "write",
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

export const interceptor = (
  descriptor: ExtensionInterceptorDescriptor,
): InterceptorContribution => ({ _kind: "interceptor", descriptor })

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

export const query = (q: AnyQueryContribution): QueryKindContribution => ({
  _kind: "query",
  query: q,
})

export const mutation = (m: AnyMutationContribution): MutationKindContribution => ({
  _kind: "mutation",
  mutation: m,
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
export const extractTools = (cs: ReadonlyArray<Contribution>): ReadonlyArray<AnyToolDefinition> =>
  filterByKind(cs, "tool").map((c) => c.tool)

export const extractAgents = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<AgentContribution["agent"]> => filterByKind(cs, "agent").map((c) => c.agent)

export const extractInterceptors = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<InterceptorContribution["descriptor"]> =>
  filterByKind(cs, "interceptor").map((c) => c.descriptor)

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

export const extractQueries = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<QueryKindContribution["query"]> => filterByKind(cs, "query").map((c) => c.query)

export const extractMutations = (
  cs: ReadonlyArray<Contribution>,
): ReadonlyArray<MutationKindContribution["mutation"]> =>
  filterByKind(cs, "mutation").map((c) => c.mutation)

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
