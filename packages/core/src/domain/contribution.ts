/**
 * Contribution union — the foundational data structure for extension authoring.
 *
 * Every extension reduces to a flat array of `Contribution` values. This is the
 * canonical shape consumed by the runtime registry; the fluent `ExtensionBuilder`
 * (in `extensions/api.ts`) is sugar that lowers into a `Contribution[]`.
 *
 * The discriminator is `_kind`. New kinds are added by extending the union, not
 * by adding fields to a setup bag.
 *
 * @module
 */
import type { Effect, Layer } from "effect"
import type { AgentDefinition } from "./agent.js"
import type {
  AnyExtensionActorDefinition,
  CommandContribution,
  ExtensionInterceptorDescriptor,
  ScheduledJobContribution,
} from "./extension.js"
import type { PermissionRule } from "./permission.js"
import type { PromptSectionInput } from "./prompt.js"
import type { AnyMutationContribution } from "./mutation.js"
import type { AnyProjectionContribution } from "./projection.js"
import type { ProviderContribution } from "./provider-contribution.js"
import type { AnyQueryContribution } from "./query.js"
import type { AnyToolDefinition } from "./tool.js"
import type { TurnExecutorContribution } from "./turn-executor.js"
import type { AnyWorkflowContribution } from "./workflow.js"

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

export interface LayerContribution {
  readonly _kind: "layer"
  readonly layer: Layer.Layer<never, never, object>
}

export interface ActorContribution {
  readonly _kind: "actor"
  readonly actor: AnyExtensionActorDefinition
}

export interface CommandKindContribution {
  readonly _kind: "command"
  readonly command: CommandContribution
}

export interface ProviderKindContribution {
  readonly _kind: "provider"
  readonly provider: ProviderContribution
}

export interface TurnExecutorKindContribution {
  readonly _kind: "turn-executor"
  readonly executor: TurnExecutorContribution
}

export interface JobContribution {
  readonly _kind: "job"
  readonly job: ScheduledJobContribution
}

export interface PermissionRuleContribution {
  readonly _kind: "permission-rule"
  readonly rule: PermissionRule
}

export interface PromptSectionContribution {
  readonly _kind: "prompt-section"
  readonly section: PromptSectionInput
}

export interface BusSubscriptionContribution {
  readonly _kind: "bus-subscription"
  readonly pattern: string
  readonly handler: (envelope: {
    readonly channel: string
    readonly payload: unknown
    readonly sessionId?: string
    readonly branchId?: string
  }) => Effect.Effect<void>
}

export interface LifecycleContribution {
  readonly _kind: "lifecycle"
  readonly phase: "startup" | "shutdown"
  readonly effect: Effect.Effect<void>
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

export interface WorkflowKindContribution {
  readonly _kind: "workflow"
  readonly workflow: AnyWorkflowContribution
}

// ── Union ──

export type Contribution =
  | ToolContribution
  | AgentContribution
  | InterceptorContribution
  | LayerContribution
  | ActorContribution
  | CommandKindContribution
  | ProviderKindContribution
  | TurnExecutorKindContribution
  | JobContribution
  | PermissionRuleContribution
  | PromptSectionContribution
  | BusSubscriptionContribution
  | LifecycleContribution
  | ProjectionKindContribution
  | QueryKindContribution
  | MutationKindContribution
  | WorkflowKindContribution

export type ContributionKind = Contribution["_kind"]

// ── Smart constructors ──

export const tool = (t: AnyToolDefinition): ToolContribution => ({ _kind: "tool", tool: t })

export const agent = (a: AgentDefinition): AgentContribution => ({ _kind: "agent", agent: a })

export const interceptor = (
  descriptor: ExtensionInterceptorDescriptor,
): InterceptorContribution => ({ _kind: "interceptor", descriptor })

export const layer = <A, R>(l: Layer.Layer<A, never, R>): LayerContribution => ({
  _kind: "layer",
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  layer: l as Layer.Layer<never, never, object>,
})

export const actor = (a: AnyExtensionActorDefinition): ActorContribution => ({
  _kind: "actor",
  actor: a,
})

export const command = (c: CommandContribution): CommandKindContribution => ({
  _kind: "command",
  command: c,
})

export const provider = (p: ProviderContribution): ProviderKindContribution => ({
  _kind: "provider",
  provider: p,
})

export const turnExecutor = (e: TurnExecutorContribution): TurnExecutorKindContribution => ({
  _kind: "turn-executor",
  executor: e,
})

export const job = (j: ScheduledJobContribution): JobContribution => ({ _kind: "job", job: j })

export const permissionRule = (r: PermissionRule): PermissionRuleContribution => ({
  _kind: "permission-rule",
  rule: r,
})

export const promptSection = (s: PromptSectionInput): PromptSectionContribution => ({
  _kind: "prompt-section",
  section: s,
})

export const busSubscription = (
  pattern: string,
  handler: BusSubscriptionContribution["handler"],
): BusSubscriptionContribution => ({ _kind: "bus-subscription", pattern, handler })

export const onStartup = (effect: Effect.Effect<void>): LifecycleContribution => ({
  _kind: "lifecycle",
  phase: "startup",
  effect,
})

export const onShutdown = (effect: Effect.Effect<void>): LifecycleContribution => ({
  _kind: "lifecycle",
  phase: "shutdown",
  effect,
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

export const workflow = (w: AnyWorkflowContribution): WorkflowKindContribution => ({
  _kind: "workflow",
  workflow: w,
})

// ── Filters ──

type ContributionByKind<K extends ContributionKind> = Extract<Contribution, { readonly _kind: K }>

/** Return only contributions of the given kind. */
export const filterByKind = <K extends ContributionKind>(
  contributions: ReadonlyArray<Contribution>,
  kind: K,
): ReadonlyArray<ContributionByKind<K>> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  contributions.filter((c): c is ContributionByKind<K> => c._kind === kind)
