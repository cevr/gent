/**
 * Extension authoring API.
 *
 * Single entry point: `defineExtension({ id, contributions })`. The factory
 * receives the setup context and returns a flat `Contribution[]` (or an
 * Effect that yields one). Smart constructors (`toolContribution`,
 * `agentContribution`, `layerContribution`, etc.) are re-exported from
 * `domain/contribution.js`.
 *
 * Effect-native end-to-end: every contribution returns Effect. There are no
 * Promise edges in the contribution surface — gent is a library used inside
 * Effect programs.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import {
 *   defineExtension,
 *   defineTool,
 *   toolContribution,
 *   layerContribution,
 * } from "@gent/core/extensions/api"
 *
 * export default defineExtension({
 *   id: "my-ext",
 *   contributions: () => [
 *     toolContribution(MyTool),
 *     layerContribution(MyService.Live),
 *   ],
 * })
 * ```
 *
 * @module
 */
import { Effect, type Layer } from "effect"
import type {
  ExtensionLoadError,
  GentExtension,
  ExtensionSetup,
  ExtensionInterceptorDescriptor,
  AnyExtensionActorDefinition,
  ScheduledJobContribution,
  CommandContribution,
  ExtensionSetupContext,
} from "../domain/extension.js"
import type { AnyToolDefinition } from "../domain/tool.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../domain/driver.js"
import type { AgentDefinition } from "../domain/agent.js"
import type { PromptSectionInput } from "../domain/prompt.js"
import type { AgentEvent } from "../domain/event.js"
import type { PermissionRule } from "../domain/permission.js"
import { type Contribution, filterByKind } from "../domain/contribution.js"
import type { AnyMutationContribution } from "../domain/mutation.js"
import type { AnyProjectionContribution } from "../domain/projection.js"
import type { AnyQueryContribution } from "../domain/query.js"
import type { AnyWorkflowContribution } from "../domain/workflow.js"

// ── Re-exports for full-power extension authors ──

export {
  defineTool,
  ToolDefinitionBrand,
  type AnyToolDefinition,
  type ToolContext,
} from "../domain/tool.js"
export {
  defineAgent,
  AgentDefinition,
  AgentDefinitionBrand,
  AgentName,
  DEFAULT_AGENT_NAME,
  DriverRef,
  ModelDriverRef,
  ExternalDriverRef,
  AgentSpec,
  RunSpecSchema,
  AgentRunOverridesSchema,
  type RunSpec,
  type AgentRunOverrides,
  resolveRunPersistence,
  getDurableAgentRunSessionId,
  AgentRunError,
  type AgentRunResult,
} from "../domain/agent.js"
export {
  defineInterceptor,
  type ExtensionInterceptorDescriptor,
  type ExtensionInterceptorKey,
  type ExtensionInterceptorMap,
  type ExtensionActorDefinition,
  type AnyExtensionActorDefinition,
  type TurnProjection,
  type ScheduledJobContribution,
  type CommandContribution,
  type ExtensionEffect,
  type ReduceResult,
  type ExtensionReduceContext,
  type ExtensionTurnContext,
  type SystemPromptInput,
  type ToolExecuteInput,
  type PermissionCheckInput,
  type ContextMessagesInput,
  type TurnBeforeInput,
  type TurnAfterInput,
  type ToolResultInput,
  type MessageInputInput,
  type MessageOutputInput,
} from "../domain/extension.js"
export {
  ExtensionMessage,
  ExtensionMessageEnvelope,
  getExtensionMessageMetadata,
  getExtensionReplySchema,
  isExtensionRequestMessage,
  listExtensionProtocolDefinitions,
  type ExtensionProtocol,
  type ExtensionCommandDefinition,
  type ExtensionCommandMessage,
  type ExtensionRequestDefinition,
  type ExtensionRequestMessage,
  type AnyExtensionCommandMessage,
  type AnyExtensionRequestMessage,
  type ExtractExtensionReply,
} from "../domain/extension-protocol.js"
export type { PromptSection, PromptSectionInput, DynamicPromptSection } from "../domain/prompt.js"
export type { TurnExecutor, TurnContext, TurnEvent } from "../domain/driver.js"
export {
  TurnError,
  TextDelta,
  ReasoningDelta,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  Finished as TurnFinished,
  TurnEventUsage,
} from "../domain/driver.js"
export type {
  AnyDriverContribution,
  ExternalDriverContribution,
  ModelDriverContribution,
  ProviderAuthContribution,
  ProviderAuthInfo,
  ProviderAuthorizationResult,
  ProviderAuthorizeContext,
  ProviderCallbackContext,
  ProviderHints,
  ProviderResolution,
  PersistAuth,
} from "../domain/driver.js"
export { DriverError } from "../domain/driver.js"
export {
  AgentEvent,
  type Question,
  QuestionSchema,
  QuestionOptionSchema,
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskStopped,
  TaskDeleted,
} from "../domain/event.js"
export type { ExtensionStorage } from "../runtime/extensions/extension-storage.js"
export { SessionId, BranchId, TaskId, ArtifactId, MessageId, ToolCallId } from "../domain/ids.js"
export { ModelId } from "../domain/model.js"
export { Task, TaskStatus, TaskTransitionError, isValidTaskTransition } from "../domain/task.js"
export { AuthMethod } from "../domain/auth-method.js"
export { AuthOauth } from "../domain/auth-store.js"
export {
  type Message,
  type MessagePart,
  type MessageMetadata,
  type Branch,
} from "../domain/message.js"
export { PermissionRule, type PermissionResult } from "../domain/permission.js"
export { OutputBuffer, saveFullOutput, headTailChars } from "../domain/output-buffer.js"
export type { ExtensionHostContext } from "../domain/extension-host-context.js"
export { isRecord, isRecordArray } from "../domain/guards.js"
export { EventPublisher } from "../domain/event-publisher.js"
export { FileIndex } from "../domain/file-index.js"
export { FileLockService } from "../domain/file-lock.js"
export {
  defineExtensionPackage,
  type ExtensionPackage,
  type ExtensionInput,
} from "../domain/extension-package.js"
export {
  type Contribution,
  type ContributionKind,
  type ToolContribution,
  type AgentContribution,
  type InterceptorContribution as InterceptorKindContribution,
  type LayerContribution,
  type CommandKindContribution,
  type ModelDriverKindContribution,
  type ExternalDriverKindContribution,
  type JobContribution,
  type PermissionRuleContribution,
  type PromptSectionContribution,
  type BusSubscriptionContribution,
  type LifecycleContribution,
  type ProjectionKindContribution,
  type QueryKindContribution,
  type MutationKindContribution,
  type WorkflowKindContribution,
  filterByKind,
  // smart constructors
  tool as toolContribution,
  agent as agentContribution,
  interceptor as interceptorContribution,
  layer as layerContribution,
  command as commandContribution,
  modelDriver as modelDriverContribution,
  externalDriver as externalDriverContribution,
  job as jobContribution,
  permissionRule as permissionRuleContribution,
  promptSection as promptSectionContribution,
  busSubscription as busSubscriptionContribution,
  onStartup as onStartupContribution,
  onShutdown as onShutdownContribution,
  projection as projectionContribution,
  query as queryContribution,
  mutation as mutationContribution,
  workflow as workflowContribution,
} from "../domain/contribution.js"
export type {
  ProjectionContribution,
  ProjectionContext,
  ProjectionUiContext,
  ProjectionTurnContext,
  ProjectionUiSurface,
  AnyProjectionContribution,
} from "../domain/projection.js"
export { ProjectionError } from "../domain/projection.js"
export type {
  QueryContribution,
  QueryContext,
  QueryRef,
  AnyQueryContribution,
} from "../domain/query.js"
export { QueryError, QueryNotFoundError } from "../domain/query.js"
export type {
  MutationContribution,
  MutationContext,
  MutationRef,
  AnyMutationContribution,
} from "../domain/mutation.js"
export { MutationError, MutationNotFoundError } from "../domain/mutation.js"
export type {
  WorkflowContribution,
  WorkflowEffect,
  WorkflowInitContext,
  AnyWorkflowContribution,
} from "../domain/workflow.js"
export {
  InteractionPendingReader,
  type InteractionPendingReaderService,
  type PendingInteraction,
} from "../storage/interaction-pending-reader.js"
export type {
  InterceptorContribution as InterceptorContributionDescriptor,
  InterceptorKey,
  InterceptorMap,
} from "../domain/interceptor.js"
export { InterceptorError } from "../domain/interceptor.js"
export { buildToolJsonSchema, flattenAllOf } from "../domain/tool-schema.js"
export { ProviderAuthError } from "../providers/provider-auth.js"
export { ToolRunner, type ToolRunnerService } from "../runtime/agent/tool-runner.js"

// ── Simple Event (curated subset of AgentEvent for external authors) ──

export type SimpleEventType =
  // Session lifecycle
  | "session-started"
  | "session-name-updated"
  | "session-settings-updated"
  // Messages
  | "message-received"
  // Streaming
  | "stream-started"
  | "stream-chunk"
  | "stream-ended"
  // Turn lifecycle
  | "turn-completed"
  | "turn-recovery-applied"
  // Tool calls
  | "tool-call-started"
  | "tool-call-succeeded"
  | "tool-call-failed"
  // Agent lifecycle
  | "agent-switched"
  | "agent-restarted"
  // Subagent lifecycle
  | "subagent-spawned"
  | "subagent-succeeded"
  | "subagent-failed"
  // Tasks
  | "task-created"
  | "task-updated"
  | "task-completed"
  | "task-failed"
  | "task-stopped"
  | "task-deleted"
  // Branching
  | "branch-created"
  | "branch-switched"
  // Questions
  | "questions-asked"
  // Errors
  | "error-occurred"

export interface SimpleEvent {
  readonly type: SimpleEventType
  readonly _tag: string
  readonly raw: SimpleEventRaw
}

type LegacySimpleAgentRunEvent =
  | (Omit<Extract<AgentEvent, { readonly _tag: "AgentRunSpawned" }>, "_tag"> & {
      readonly _tag: "SubagentSpawned"
    })
  | (Omit<Extract<AgentEvent, { readonly _tag: "AgentRunSucceeded" }>, "_tag"> & {
      readonly _tag: "SubagentSucceeded"
    })
  | (Omit<Extract<AgentEvent, { readonly _tag: "AgentRunFailed" }>, "_tag"> & {
      readonly _tag: "SubagentFailed"
    })

type SimpleEventRaw = AgentEvent | LegacySimpleAgentRunEvent

// ── Removed in C12 ──
//
// `ExtensionBuilder`, `extension(id, factory)`, `SimpleToolDef`/`SimpleAgentDef`,
// and `ext.exec()` (`ExecError`/`ExecResult`) were the legacy fluent-builder
// authoring surface. All builtin and example extensions now compose
// `Contribution[]` arrays via `defineExtension({ id, contributions })`. The
// interceptor compilation algorithm moved to `runtime/extensions/interceptor-registry.ts`;
// the `runtime/extensions/hooks.ts` shell is gone.
//
// The `LoweredBuckets`/`placeContribution`/`bucketsToSetup` helpers below
// remain — they lower contributions into the runtime `ExtensionSetup` shape
// that the registry consumes today. Subtraction continues in a follow-up
// when the registry reads `Contribution[]` directly (post-planify).

// ── Public API ──

// ExtensionSetupContext re-exported from domain — single source of truth
export type { ExtensionSetupContext } from "../domain/extension.js"

type BusSubscriptionEntry = NonNullable<ExtensionSetup["busSubscriptions"]>[number]

/** Merge startup effects in registration order. */
const mergeEffectHooks = (
  effects: ReadonlyArray<Effect.Effect<void>>,
): Effect.Effect<void> | undefined =>
  effects.length === 0 ? undefined : Effect.all(effects, { discard: true }).pipe(Effect.asVoid)

/**
 * Lower a flat `Contribution[]` array into the runtime `ExtensionSetup` shape.
 *
 * Single-call kinds (tools/agents/promptSections/permissionRules/layer/actor/provider/jobs)
 * accumulate in registration order; multi-call kinds (commands/interceptors/jobs/bus/lifecycle)
 * are appended. Used by `defineExtension({...})` to materialize the registry-facing setup
 * bag from the canonical contribution array. Goes away with `ExtensionSetup` in a follow-up
 * when the registry reads `Contribution[]` directly.
 */
interface LoweredBuckets {
  tools: AnyToolDefinition[]
  agents: AgentDefinition[]
  interceptors: ExtensionInterceptorDescriptor[]
  commands: CommandContribution[]
  promptSections: PromptSectionInput[]
  permissionRules: PermissionRule[]
  modelDrivers: ModelDriverContribution[]
  externalDrivers: ExternalDriverContribution[]
  jobs: ScheduledJobContribution[]
  busSubscriptions: BusSubscriptionEntry[]
  projections: AnyProjectionContribution[]
  queries: AnyQueryContribution[]
  mutations: AnyMutationContribution[]
  startupEffects: Array<Effect.Effect<void>>
  shutdownEffects: Array<Effect.Effect<void>>
  actor: AnyExtensionActorDefinition | undefined
  layer: Layer.Layer<never, never, object> | undefined
}

const emptyBuckets = (): LoweredBuckets => ({
  tools: [],
  agents: [],
  interceptors: [],
  commands: [],
  promptSections: [],
  permissionRules: [],
  modelDrivers: [],
  externalDrivers: [],
  jobs: [],
  busSubscriptions: [],
  projections: [],
  queries: [],
  mutations: [],
  startupEffects: [],
  shutdownEffects: [],
  actor: undefined,
  layer: undefined,
})

const placeContribution = (b: LoweredBuckets, c: Contribution): void => {
  switch (c._kind) {
    case "tool":
      b.tools.push(c.tool)
      return
    case "agent":
      b.agents.push(c.agent)
      return
    case "interceptor":
      b.interceptors.push(c.descriptor)
      return
    case "command":
      b.commands.push(c.command)
      return
    case "prompt-section":
      b.promptSections.push(c.section)
      return
    case "permission-rule":
      b.permissionRules.push(c.rule)
      return
    case "model-driver":
      b.modelDrivers.push(c.driver)
      return
    case "external-driver":
      b.externalDrivers.push(c.driver)
      return
    case "job":
      b.jobs.push(c.job)
      return
    case "bus-subscription":
      b.busSubscriptions.push({ pattern: c.pattern, handler: c.handler })
      return
    case "projection":
      b.projections.push(c.projection)
      return
    case "query":
      b.queries.push(c.query)
      return
    case "mutation":
      b.mutations.push(c.mutation)
      return
    case "lifecycle":
      if (c.phase === "startup") b.startupEffects.push(c.effect)
      else b.shutdownEffects.push(c.effect)
      return
    case "workflow":
      // `WorkflowContribution` and `ExtensionActorDefinition` are
      // structurally identical (same fields, same machine type) — the legacy
      // `setup.actor` slot is the runtime-internal storage for the single
      // workflow per extension. No field-by-field copy is needed.
      placeWorkflow(b, c.workflow)
      return
    case "layer":
      b.layer = c.layer
      return
    default: {
      // Exhaustiveness: adding a new Contribution kind without updating this switch
      // is a compile error here. Future commits depend on this guard.
      const _exhaustive: never = c
      return _exhaustive
    }
  }
}

/** Single-slot guard: at most one workflow per extension. */
const placeWorkflow = (b: LoweredBuckets, def: AnyWorkflowContribution): void => {
  if (b.actor !== undefined) {
    throw new Error("extension may declare at most one workflow")
  }
  // `WorkflowContribution` is structurally a `ExtensionActorDefinition` — the
  // runtime stores it in the `b.actor` slot which is the internal field name
  // until the registry's setup-bag is dropped (Phase 6 / B2).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  b.actor = def as AnyExtensionActorDefinition
}

const bucketsToSetup = (b: LoweredBuckets): ExtensionSetup => {
  const onStartup = mergeEffectHooks(b.startupEffects)
  const onShutdown = mergeEffectHooks(b.shutdownEffects)
  return {
    ...(b.tools.length > 0 ? { tools: b.tools } : {}),
    ...(b.agents.length > 0 ? { agents: b.agents } : {}),
    ...(b.commands.length > 0 ? { commands: b.commands } : {}),
    ...(b.promptSections.length > 0 ? { promptSections: b.promptSections } : {}),
    ...(b.interceptors.length > 0 ? { hooks: { interceptors: b.interceptors } } : {}),
    ...(b.layer !== undefined ? { layer: b.layer } : {}),
    ...(b.modelDrivers.length > 0 ? { modelDrivers: b.modelDrivers } : {}),
    ...(b.externalDrivers.length > 0 ? { externalDrivers: b.externalDrivers } : {}),
    ...(b.jobs.length > 0 ? { jobs: b.jobs } : {}),
    ...(b.busSubscriptions.length > 0 ? { busSubscriptions: b.busSubscriptions } : {}),
    ...(b.projections.length > 0 ? { projections: b.projections } : {}),
    ...(b.queries.length > 0 ? { queries: b.queries } : {}),
    ...(b.mutations.length > 0 ? { mutations: b.mutations } : {}),
    ...(b.actor !== undefined ? { actor: b.actor } : {}),
    ...(b.permissionRules.length > 0 ? { permissionRules: b.permissionRules } : {}),
    onStartup,
    onShutdown,
  } satisfies ExtensionSetup
}

export const lowerContributions = (contributions: ReadonlyArray<Contribution>): ExtensionSetup => {
  const buckets = emptyBuckets()
  for (const c of contributions) placeContribution(buckets, c)
  return bucketsToSetup(buckets)
}

/**
 * Define an extension as a flat array of contributions.
 *
 * The canonical authoring shape — no fluent chain, no setup bag. The factory
 * receives the setup context and returns a `Contribution[]` (or an Effect
 * that yields one). Later scope wins per the registry's scope precedence rule.
 *
 * @example
 * ```ts
 * import { defineExtension, toolContribution, layerContribution } from "@gent/core/extensions/api"
 *
 * export const MyExt = defineExtension({
 *   id: "my-ext",
 *   contributions: ({ ctx }) => [
 *     layerContribution(MyService.Live),
 *     toolContribution(MyTool),
 *   ],
 * })
 * ```
 */
export const defineExtension = (params: {
  readonly id: string
  readonly contributions: (args: {
    readonly ctx: ExtensionSetupContext
  }) => ReadonlyArray<Contribution> | Effect.Effect<ReadonlyArray<Contribution>, ExtensionLoadError>
}): GentExtension => ({
  manifest: { id: params.id },
  setup: (ctx) =>
    Effect.gen(function* () {
      const result = params.contributions({ ctx })
      const contribs: ReadonlyArray<Contribution> = Effect.isEffect(result) ? yield* result : result
      return lowerContributions(contribs)
    }),
})
