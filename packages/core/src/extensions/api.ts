/**
 * Fluent extension authoring API.
 *
 * Effect-native end-to-end: every contribution returns Effect. There are no Promise
 * edges in the contribution surface — gent is a library used inside Effect programs.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { extension } from "@gent/core/extensions/api"
 *
 * export default extension("my-ext", ({ ext }) =>
 *   ext
 *     .tools({
 *       name: "greet",
 *       description: "Say hello",
 *       execute: (p) => Effect.succeed(`Hi ${p.name}!`),
 *     })
 *     .on("prompt.system", (input, next) =>
 *       next(input).pipe(Effect.map((s) => s + "\n-- house rule")),
 *     )
 *     .actor(MyActor)
 *     .layer(MyService.Live)
 *     .provider(myProvider)
 * )
 * ```
 *
 * @module
 */
import { Data, Effect, Schema, Stream, type Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  defineInterceptor,
  ExtensionLoadError,
  type GentExtension,
  type ExtensionSetup,
  type ExtensionInterceptorDescriptor,
  type ExtensionInterceptorKey,
  type ExtensionInterceptorMap,
  type AnyExtensionActorDefinition,
  type ProviderContribution,
  type ScheduledJobContribution,
  type CommandContribution,
  type ExtensionSetupContext,
} from "../domain/extension.js"
import {
  defineTool,
  ToolDefinitionBrand,
  type ToolContext,
  type AnyToolDefinition,
} from "../domain/tool.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import type { TurnExecutorContribution } from "../domain/turn-executor.js"
import { type AgentDefinition, AgentDefinitionBrand, defineAgent } from "../domain/agent.js"
import type { PromptSection, PromptSectionInput, DynamicPromptSection } from "../domain/prompt.js"
import type { AgentEvent } from "../domain/event.js"
import { ModelId } from "../domain/model.js"
import type { PermissionRule } from "../domain/permission.js"
import {
  createExtensionStorage,
  type ExtensionStorage,
} from "../runtime/extensions/extension-storage.js"
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
  ModelExecution,
  ExternalExecution,
  AgentExecution,
  AUDITOR_PROMPT,
  LIBRARIAN_PROMPT,
  ARCHITECT_PROMPT,
  COWORK_PROMPT,
  DEEPWORK_PROMPT,
  EXPLORE_PROMPT,
  SUMMARIZER_PROMPT,
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
  type ProviderAuthInfo,
  type ProviderHints,
  type ProviderContribution,
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
export type {
  TurnExecutor,
  TurnExecutorContribution,
  TurnContext,
  TurnEvent,
} from "../domain/turn-executor.js"
export {
  TurnError,
  TextDelta,
  ReasoningDelta,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  Finished as TurnFinished,
  TurnEventUsage,
} from "../domain/turn-executor.js"
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
export type { ProviderResolution } from "../domain/provider-contribution.js"
export {
  type Contribution,
  type ContributionKind,
  type ToolContribution,
  type AgentContribution,
  type InterceptorContribution as InterceptorKindContribution,
  type LayerContribution,
  type ActorContribution,
  type CommandKindContribution,
  type ProviderKindContribution,
  type TurnExecutorKindContribution,
  type JobContribution,
  type PermissionRuleContribution,
  type PromptSectionContribution,
  type BusSubscriptionContribution,
  type LifecycleContribution,
  type ProjectionKindContribution,
  type WorkflowKindContribution,
  filterByKind,
  // smart constructors
  tool as toolContribution,
  agent as agentContribution,
  interceptor as interceptorContribution,
  layer as layerContribution,
  actor as actorContribution,
  command as commandContribution,
  provider as providerContribution,
  turnExecutor as turnExecutorContribution,
  job as jobContribution,
  permissionRule as permissionRuleContribution,
  promptSection as promptSectionContribution,
  busSubscription as busSubscriptionContribution,
  onStartup as onStartupContribution,
  onShutdown as onShutdownContribution,
  projection as projectionContribution,
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

// ── Simple Parameter Types ──

interface SimpleParam {
  readonly type: "string" | "number" | "boolean"
  readonly description?: string
  readonly optional?: boolean
}

type SimpleParams = Record<string, SimpleParam>

// ── Simple Tool Definition ──

export interface SimpleToolDef {
  readonly name: string
  readonly description: string
  readonly parameters?: SimpleParams
  readonly concurrency?: "serial" | "parallel"
  readonly idempotent?: boolean
  readonly interactive?: boolean
  readonly promptSnippet?: string
  readonly promptGuidelines?: ReadonlyArray<string>
  readonly execute: (params: Record<string, unknown>, ctx: ToolContext) => Effect.Effect<unknown>
}

// ── Simple Agent Definition ──

export interface SimpleAgentDef {
  readonly name: string
  readonly model: string
  readonly systemPromptAddendum?: string
  readonly description?: string
  readonly allowedTools?: ReadonlyArray<string>
  readonly deniedTools?: ReadonlyArray<string>
  readonly temperature?: number
}

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

// ── Errors ──

export class ExecError extends Data.TaggedError("@gent/core/src/extensions/api/ExecError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly timedOut: boolean
}

// ── Internal Helpers ──

const isFullToolDef = (def: SimpleToolDef | AnyToolDefinition): def is AnyToolDefinition =>
  typeof def === "object" && def !== null && ToolDefinitionBrand in def

const schemaTypeMap: Record<string, Schema.Schema<unknown>> = {
  string: Schema.String as Schema.Schema<unknown>,
  number: Schema.Number as Schema.Schema<unknown>,
  boolean: Schema.Boolean as Schema.Schema<unknown>,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildParamsSchema = (params?: SimpleParams): Schema.Decoder<any, never> => {
  if (params === undefined || Object.keys(params).length === 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    return Schema.Struct({}) as unknown as Schema.Decoder<any, never>
  }
  const fields: Record<string, Schema.Schema<unknown>> = {}
  for (const [key, param] of Object.entries(params)) {
    const base = schemaTypeMap[param.type] ?? Schema.Unknown
    fields[key] = param.optional === true ? Schema.optional(base) : base
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  return Schema.Struct(fields) as unknown as Schema.Decoder<any, never>
}

const convertSimpleTool = (def: SimpleToolDef): AnyToolDefinition =>
  defineTool({
    name: def.name,
    description: def.description,
    params: buildParamsSchema(def.parameters),
    concurrency: def.concurrency,
    idempotent: def.idempotent,
    interactive: def.interactive,
    promptSnippet: def.promptSnippet,
    promptGuidelines: def.promptGuidelines,
    execute: (params: Record<string, unknown>, ctx: ToolContext) => def.execute(params, ctx),
  }) as AnyToolDefinition

const convertSimpleAgent = (def: SimpleAgentDef): AgentDefinition =>
  defineAgent({
    name: def.name,
    model: ModelId.of(def.model),
    systemPromptAddendum: def.systemPromptAddendum,
    description: def.description,
    allowedTools: def.allowedTools,
    deniedTools: def.deniedTools,
    temperature: def.temperature,
  })

// ── Extension Builder ──

/** Opaque brand carried by all builder chain results. Used as the factory return type
 *  so that `Omit<ExtensionBuilder<P>, ...>` is assignable to it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExtensionBuilderResult<_Provides = never> {}

export interface ExtensionBuilder<Provides = never> extends ExtensionBuilderResult<Provides> {
  // ── Registration (single-call, variadic where applicable) ──

  /** Register tools. Accepts SimpleToolDef or full AnyToolDefinition. Single call. */
  tools(
    ...defs: ReadonlyArray<SimpleToolDef | AnyToolDefinition>
  ): Omit<ExtensionBuilder<Provides>, "tools">
  /** Register agents. Accepts SimpleAgentDef or full AgentDefinition. Single call. */
  agents(
    ...defs: ReadonlyArray<SimpleAgentDef | AgentDefinition>
  ): Omit<ExtensionBuilder<Provides>, "agents">
  /** Register a slash command. Multiple calls ok. Handler returns Effect. */
  command(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtensionHostContext) => Effect.Effect<void>
    },
  ): ExtensionBuilder<Provides>
  /** Register prompt sections. Static or dynamic. Single call.
   *  Dynamic sections' R is constrained to Provides — services must come from .layer(). */
  promptSections(
    ...sections: ReadonlyArray<PromptSection | DynamicPromptSection<Provides>>
  ): Omit<ExtensionBuilder<Provides>, "promptSections">
  /** Register permission deny/allow rules. Single call. */
  permissionRules(
    ...rules: ReadonlyArray<PermissionRule>
  ): Omit<ExtensionBuilder<Provides>, "permissionRules">
  /** Register a turn executor for external agent dispatch. Multiple calls ok. */
  turnExecutor(
    id: string,
    executor: TurnExecutorContribution["executor"],
  ): ExtensionBuilder<Provides>
  /** Register an Effect-native interceptor hook. Multiple calls ok. */
  on<K extends ExtensionInterceptorKey>(
    key: K,
    handler: ExtensionInterceptorMap[K],
  ): ExtensionBuilder<Provides>
  /** Spawn a shell command at setup time. Returns Effect. For runtime exec during turns,
   *  use the bash tool instead. */
  exec(
    command: string,
    args?: ReadonlyArray<string>,
    options?: { cwd?: string; timeout?: number },
  ): Effect.Effect<ExecResult, ExecError>
  /** Register a startup hook. Effect-only. Multiple calls compose in order. */
  onStartup(effect: Effect.Effect<void>): ExtensionBuilder<Provides>
  /** Register a shutdown hook. Effect-only. Multiple calls compose in order. */
  onShutdown(effect: Effect.Effect<void>): ExtensionBuilder<Provides>

  /** File-backed key-value storage, namespaced by extension ID.
   *  All methods return Effect — pipe the result, don't await. */
  readonly storage: ExtensionStorage

  // ── Full-power path (Effect-aware) ──

  /** Register a stateful actor. Single call. */
  actor(actor: AnyExtensionActorDefinition): Omit<ExtensionBuilder<Provides>, "actor">
  /** Provide a service Layer. Single call — compose with Layer.merge before passing. Widens Provides.
   *  Layers with unsatisfied requirements (R) are accepted — the runtime provides them (e.g. SqlClient). */
  layer<A, R>(layer: Layer.Layer<A, never, R>): Omit<ExtensionBuilder<Provides | A>, "layer">
  /** Register an AI model provider. Single call. */
  provider(provider: ProviderContribution): Omit<ExtensionBuilder<Provides>, "provider">
  /** Register durable host-owned scheduled jobs. Single call. */
  jobs(...jobs: ReadonlyArray<ScheduledJobContribution>): Omit<ExtensionBuilder<Provides>, "jobs">
  /** Subscribe to a bus channel. Effect-only handler. Multiple calls ok. */
  bus(
    pattern: string,
    handler: (envelope: {
      channel: string
      payload: unknown
      sessionId?: string
      branchId?: string
    }) => Effect.Effect<void>,
  ): ExtensionBuilder<Provides>
  /** Register a read-only projection (derives from services; surfaces prompt/ui/policy).
   *  Multiple calls ok. The projection's R requirement must be satisfied by `.layer()`. */
  projection(p: AnyProjectionContribution): ExtensionBuilder<Provides>
  /** Register a typed read-only RPC handler — invoked via `ctx.extension.query(ref, input)`.
   *  Multiple calls ok. The query's R requirement must be satisfied by `.layer()`. */
  query(q: AnyQueryContribution): ExtensionBuilder<Provides>
  /** Register a typed write RPC handler — invoked via `ctx.extension.mutate(ref, input)`.
   *  Multiple calls ok. The mutation's R requirement must be satisfied by `.layer()`. */
  mutation(m: AnyMutationContribution): ExtensionBuilder<Provides>
}

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
 * Lower a flat `Contribution[]` array into the legacy `ExtensionSetup` shape.
 *
 * Single-call kinds (tools/agents/promptSections/permissionRules/layer/actor/provider/jobs)
 * are merged in registration order — later contributions append to the same field.
 * Multi-call kinds (commands/interceptors/turnExecutors/jobs/bus/lifecycle) accumulate.
 *
 * This is the canonical lowering used by both `extension(...)` (builder) and
 * `defineExtension({...})`. As later commits migrate the runtime to consume
 * `Contribution[]` directly, this helper shrinks; once the registry is contribution-native
 * (Commit 12), the helper goes away with the legacy `ExtensionSetup` shape.
 */
interface LoweredBuckets {
  tools: AnyToolDefinition[]
  agents: AgentDefinition[]
  interceptors: ExtensionInterceptorDescriptor[]
  commands: CommandContribution[]
  promptSections: PromptSectionInput[]
  permissionRules: PermissionRule[]
  providers: ProviderContribution[]
  turnExecutors: TurnExecutorContribution[]
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
  providers: [],
  turnExecutors: [],
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
    case "provider":
      b.providers.push(c.provider)
      return
    case "turn-executor":
      b.turnExecutors.push(c.executor)
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
    case "actor":
      placeActor(b, c.actor)
      return
    case "workflow":
      // Workflows lower into the actor shape so the existing
      // `ExtensionStateRuntime` hosts them. The dedicated `workflow-runtime.ts`
      // and the deletion of the actor primitive happen later in C8 once the
      // in-tree consumers (auto, handoff, ACP) have migrated to the workflow
      // surface. Same single-slot constraint as actors today: at most one
      // workflow per extension.
      placeActor(b, workflowToActor(c.workflow))
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

/** Single-slot guard: extensions declare at most one actor or workflow today,
 *  inherited from the legacy `ExtensionSetup.actor` shape. */
const placeActor = (b: LoweredBuckets, def: AnyExtensionActorDefinition): void => {
  if (b.actor !== undefined) {
    throw new Error(
      "extension may declare at most one workflow or actor (single-slot constraint inherited from ExtensionSetup.actor)",
    )
  }
  b.actor = def
}

/**
 * Lower a `WorkflowContribution` into the legacy `ExtensionActorDefinition`
 * shape. Workflows do NOT carry UI/snapshot/turn (those belong to
 * ProjectionContribution per `composability-not-flags`); the actor's optional
 * fields stay undefined.
 */
const workflowToActor = (w: AnyWorkflowContribution): AnyExtensionActorDefinition => ({
  machine: w.machine,
  ...(w.slots !== undefined ? { slots: w.slots } : {}),
  ...(w.mapEvent !== undefined ? { mapEvent: w.mapEvent } : {}),
  ...(w.mapCommand !== undefined ? { mapCommand: w.mapCommand } : {}),
  ...(w.mapRequest !== undefined ? { mapRequest: w.mapRequest } : {}),
  ...(w.afterTransition !== undefined ? { afterTransition: w.afterTransition } : {}),
  ...(w.stateSchema !== undefined ? { stateSchema: w.stateSchema } : {}),
  ...(w.protocols !== undefined ? { protocols: w.protocols } : {}),
  ...(w.onInit !== undefined ? { onInit: w.onInit } : {}),
  // Transitional lowering bridge (deleted in C12) — preserves UI/turn
  // surfaces for workflows whose UI is derived from machine state today.
  ...(w.snapshot !== undefined ? { snapshot: w.snapshot } : {}),
  ...(w.turn !== undefined ? { turn: w.turn } : {}),
})

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
    ...(b.providers.length > 0 ? { providers: b.providers } : {}),
    ...(b.turnExecutors.length > 0 ? { turnExecutors: b.turnExecutors } : {}),
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

/** Effect-native shell exec via ChildProcess. Used by `ext.exec()` at setup time.
 *  Captures the spawner from setup context — no service requirement leaks. */
const execEffect = (
  spawner: ChildProcessSpawner["Service"],
  defaultCwd: string,
  command: string,
  args: ReadonlyArray<string> | undefined,
  options: { cwd?: string; timeout?: number } | undefined,
): Effect.Effect<ExecResult, ExecError> => {
  const timeoutMs = options?.timeout ?? 30_000
  const program = Effect.gen(function* () {
    const cmd = ChildProcess.make(command, args ?? [], {
      cwd: options?.cwd ?? defaultCwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const handle = yield* spawner.spawn(cmd)
    const decoder = new TextDecoder()
    const decode = (chunks: ReadonlyArray<Uint8Array>) =>
      chunks.map((c) => decoder.decode(c)).join("")
    const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all(
      [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    )
    return {
      stdout: decode(stdoutChunks),
      stderr: decode(stderrChunks),
      exitCode,
      timedOut: false,
    } satisfies ExecResult
  })
  return program.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.succeed<ExecResult>({ stdout: "", stderr: "", exitCode: -1, timedOut: true }),
    }),
    Effect.catchEager((e) => Effect.fail(new ExecError({ message: String(e), cause: e }))),
  )
}

/**
 * Create an extension. One API for both simple and full-power extensions.
 *
 * The callback runs synchronously inside the setup Effect. It receives `{ ext, ctx }`
 * and must return the builder (for fluent chaining). For async work, use `onStartup`.
 *
 * @example
 * ```ts
 * // Simple
 * export const MyExt = extension("my-ext", ({ ext }) =>
 *   ext.tools(MyTool, OtherTool)
 * )
 *
 * // With layer + dynamic prompt section (Provides tracking)
 * export const MyExt = extension("my-ext", ({ ext, ctx }) =>
 *   ext
 *     .layer(MyService.Live)
 *     .tools(MyTool)
 *     .promptSections({ id: "x", priority: 80, resolve: Effect.gen(...) })
 * )
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const extension = <P = never>(
  id: string,
  factory: (args: {
    ext: ExtensionBuilder<never>
    ctx: ExtensionSetupContext
  }) => ExtensionBuilderResult<P>,
): GentExtension => ({
  manifest: { id },
  setup: (ctx) =>
    Effect.gen(function* () {
      // Builder lowers into a flat Contribution[] — single source of truth.
      // Single-call kinds (tools/agents/promptSections/permissionRules/layer/actor/provider/jobs)
      // are guarded by name; multi-call kinds accumulate.
      const _contributions: Contribution[] = []
      const _calledOnce = new Set<string>()

      const guardSingle = (name: string) => {
        if (_calledOnce.has(name)) {
          throw new Error(`extension "${id}": ${name}() can only be called once`)
        }
        _calledOnce.add(name)
      }

      const extensionStorage = createExtensionStorage(
        id,
        `${ctx.home}/.gent/extensions`,
        ctx.fs,
        ctx.path,
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: ExtensionBuilder<any> = {
        storage: extensionStorage,

        tools: (...defs) => {
          guardSingle("tools")
          for (const def of defs) {
            const t = isFullToolDef(def) ? def : convertSimpleTool(def as SimpleToolDef)
            _contributions.push({ _kind: "tool", tool: t })
          }
          return builder
        },

        agents: (...defs) => {
          guardSingle("agents")
          for (const def of defs) {
            const a =
              AgentDefinitionBrand in def || "_tag" in def
                ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                  (def as AgentDefinition)
                : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                  convertSimpleAgent(def as SimpleAgentDef)
            _contributions.push({ _kind: "agent", agent: a })
          }
          return builder
        },

        turnExecutor: (id, executor) => {
          _contributions.push({ _kind: "turn-executor", executor: { id, executor } })
          return builder
        },

        command: (name, options) => {
          _contributions.push({
            _kind: "command",
            command: { name, description: options.description, handler: options.handler },
          })
          return builder
        },

        promptSections: (...sections) => {
          guardSingle("promptSections")
          for (const s of sections) {
            _contributions.push({
              _kind: "prompt-section",
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              section: s as PromptSectionInput,
            })
          }
          return builder
        },

        permissionRules: (...rules) => {
          guardSingle("permissionRules")
          for (const r of rules) _contributions.push({ _kind: "permission-rule", rule: r })
          return builder
        },

        on: <K extends ExtensionInterceptorKey>(key: K, handler: ExtensionInterceptorMap[K]) => {
          _contributions.push({
            _kind: "interceptor",
            descriptor: defineInterceptor(key, handler),
          })
          return builder
        },

        exec: (command, args, options) => execEffect(ctx.spawner, ctx.cwd, command, args, options),

        onStartup: (effect) => {
          _contributions.push({ _kind: "lifecycle", phase: "startup", effect })
          return builder
        },
        onShutdown: (effect) => {
          _contributions.push({ _kind: "lifecycle", phase: "shutdown", effect })
          return builder
        },

        // Full-power methods

        actor: (a) => {
          guardSingle("actor")
          _contributions.push({ _kind: "actor", actor: a })
          return builder
        },

        layer: (l) => {
          guardSingle("layer")
          _contributions.push({
            _kind: "layer",
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            layer: l as Layer.Layer<never, never, object>,
          })
          return builder
        },
        provider: (p) => {
          guardSingle("provider")
          _contributions.push({ _kind: "provider", provider: p })
          return builder
        },
        jobs: (...entries) => {
          guardSingle("jobs")
          for (const j of entries) _contributions.push({ _kind: "job", job: j })
          return builder
        },
        bus: (pattern, handler) => {
          _contributions.push({ _kind: "bus-subscription", pattern, handler })
          return builder
        },
        projection: (p) => {
          _contributions.push({ _kind: "projection", projection: p })
          return builder
        },
        query: (q) => {
          _contributions.push({ _kind: "query", query: q })
          return builder
        },
        mutation: (m) => {
          _contributions.push({ _kind: "mutation", mutation: m })
          return builder
        },
      }

      // Run factory — synchronous; mutations land on the builder
      yield* Effect.try({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        try: () => factory({ ext: builder as ExtensionBuilder<never>, ctx }),
        catch: (e) => new ExtensionLoadError(id, `Extension factory failed: ${String(e)}`, e),
      })

      return lowerContributions(_contributions)
    }),
})
