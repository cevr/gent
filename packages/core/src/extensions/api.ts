/**
 * Extension authoring API.
 *
 * Single entry point: `defineExtension({ id, resources?, capabilities?, ... })`.
 * The factory accepts typed sub-arrays (literal arrays OR `(ctx) => array` OR
 * `(ctx) => Effect<array>` per bucket), validates them, and produces a
 * `GentExtension` whose `setup()` returns `ExtensionContributions` buckets.
 *
 * After C8 there is no flat `Contribution[]`, no `_kind` discriminator, no
 * `filterByKind`. The bucket name IS the discrimination — TypeScript catches
 * a Projection placed in `capabilities` at the call site; runtime
 * `validatePackageShape` adds field-local error messages for runtime-loaded
 * (JS) extensions.
 *
 * Effect-native end-to-end: every contribution returns Effect. There are no
 * Promise edges in the contribution surface — gent is a library used inside
 * Effect programs.
 *
 * @example
 * ```ts
 * import { defineExtension, defineResource, tool } from "@gent/core/extensions/api"
 *
 * export default defineExtension({
 *   id: "my-ext",
 *   resources: [defineResource({ scope: "process", layer: MyService.Live })],
 *   capabilities: [tool(MyTool)],
 * })
 * ```
 *
 * @example with ctx + Effect
 * ```ts
 * export default defineExtension({
 *   id: "my-ext",
 *   capabilities: ({ ctx }) =>
 *     Effect.gen(function* () {
 *       const skills = yield* loadSkills(ctx.cwd)
 *       return [tool(SearchSkillsTool(skills))]
 *     }),
 * })
 * ```
 *
 * @module
 */
import { Effect, Schema } from "effect"
import { ExtensionLoadError } from "../domain/extension.js"
import type {
  GentExtension,
  ExtensionSetupContext,
  ExtensionManifest,
} from "../domain/extension.js"
import type { ExtensionContributions } from "../domain/contribution.js"
import type { AgentDefinition } from "../domain/agent.js"
import type { AnyCapabilityContribution } from "../domain/capability.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../domain/driver.js"
import type { AnyPipelineContribution } from "../domain/pipeline.js"
import type { AnyProjectionContribution } from "../domain/projection.js"
import type { AnyResourceContribution } from "../domain/resource.js"
import type { AnySubscriptionContribution } from "../domain/subscription.js"
import type { AgentEvent } from "../domain/event.js"

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
  type ExtensionActorDefinition,
  type AnyExtensionActorDefinition,
  type TurnProjection,
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
export type { PromptSection } from "../domain/prompt.js"
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
  type ExtensionContributions,
  // Smart constructors — return bare leaf values; the bucket they're placed
  // in is the discrimination (no `_kind` field).
  tool,
  agent,
  pipeline,
  subscription,
  modelDriver,
  externalDriver,
  projection,
  query,
  mutation,
  capability,
  defineResource,
  defineLifecycleResource,
  resource,
} from "../domain/contribution.js"
// Legacy aliases — many existing call sites use the `*Contribution` suffix.
// After C8 these are pure identity wrappers and could be dropped, but the
// re-export keeps the diff focused on the structural change. C10 cleanup.
export {
  tool as toolContribution,
  agent as agentContribution,
  pipeline as pipelineContribution,
  subscription as subscriptionContribution,
  modelDriver as modelDriverContribution,
  externalDriver as externalDriverContribution,
  projection as projectionContribution,
  query as queryContribution,
  mutation as mutationContribution,
  capability as capabilityContribution,
} from "../domain/contribution.js"
export {
  type PipelineContribution,
  type AnyPipelineContribution,
  type PipelineKey,
  type PipelineHandler,
  type PipelineInput,
  type PipelineOutput,
  type PipelineMap,
  definePipeline,
} from "../domain/pipeline.js"
export {
  type SubscriptionContribution,
  type AnySubscriptionContribution,
  type SubscriptionKey,
  type SubscriptionHandler,
  type SubscriptionEvent,
  type SubscriptionMap,
  type SubscriptionFailureMode,
  defineSubscription,
} from "../domain/subscription.js"
export type {
  CapabilityContribution,
  AnyCapabilityContribution,
  CapabilityContext,
  CapabilityCoreContext,
  ModelCapabilityContext,
  CapabilityRef,
  Audience,
  Intent,
  ModelAudienceFields,
} from "../domain/capability.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"
export type {
  ResourceContribution,
  AnyResourceContribution,
  ResourceScope,
  ScopeOf,
  ResourceBusEnvelope,
  ResourceSubscription,
  ResourceSchedule,
  ResourceMachine,
  AnyResourceMachine,
  ResourceMachineEffect,
  ResourceMachineInitContext,
} from "../domain/resource.js"
export type {
  ProjectionContribution,
  ProjectionContext,
  ProjectionTurnContext,
  AnyProjectionContribution,
} from "../domain/projection.js"
export { ProjectionError } from "../domain/projection.js"
// `WorkflowRuntime` is exposed so projections (and other read-only consumers)
// can `ask` workflow-bearing extensions through their typed protocol.
// Projections may not call `send` on the runtime — enforced by lint rules
// gating writes inside `R extends ReadOnly` projection requirements.
export { WorkflowRuntime } from "../runtime/extensions/workflow-runtime.js"
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
export {
  InteractionPendingReader,
  type InteractionPendingReaderService,
  type PendingInteraction,
} from "../storage/interaction-pending-reader.js"
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

// ── Public API ──

// ExtensionSetupContext re-exported from domain — single source of truth
export type { ExtensionSetupContext } from "../domain/extension.js"

/**
 * Per-bucket spec accepted by `defineExtension`. Each bucket field can be:
 *   - a literal array (90% of cases — the extension contributes a constant set)
 *   - a `(args) => array` factory (when the bucket needs `ctx` but no Effect)
 *   - a `(args) => Effect<array>` factory (when setup needs Effect-typed work)
 *
 * Codex C8 review: prefer literal arrays as default; the variance behind one
 * helper (`resolveField`) keeps 26 of 30 builtin extensions ceremony-free
 * while preserving Effect for the 4 that genuinely need it.
 */
export type FieldSpec<A> =
  | ReadonlyArray<A>
  | ((args: {
      readonly ctx: ExtensionSetupContext
    }) => ReadonlyArray<A> | Effect.Effect<ReadonlyArray<A>, ExtensionLoadError>)

export interface DefineExtensionInput {
  readonly id: string
  readonly resources?: FieldSpec<AnyResourceContribution>
  readonly capabilities?: FieldSpec<AnyCapabilityContribution>
  readonly agents?: FieldSpec<AgentDefinition>
  readonly projections?: FieldSpec<AnyProjectionContribution>
  readonly pipelines?: FieldSpec<AnyPipelineContribution>
  readonly subscriptions?: FieldSpec<AnySubscriptionContribution>
  readonly modelDrivers?: FieldSpec<ModelDriverContribution>
  readonly externalDrivers?: FieldSpec<ExternalDriverContribution>
  readonly pulseTags?: ReadonlyArray<string>
}

/**
 * Resolve a single bucket field — accepts literal array, sync factory, or
 * Effect-returning factory. Errors are annotated with the bucket name so
 * the failure message points at the field, not "setup failed" (codex
 * C8 finding 2).
 */
const resolveField = <A>(
  manifest: ExtensionManifest,
  field: string,
  spec: FieldSpec<A> | undefined,
  ctx: ExtensionSetupContext,
): Effect.Effect<ReadonlyArray<A>, ExtensionLoadError> =>
  Effect.gen(function* () {
    if (spec === undefined) return []
    if (Array.isArray(spec)) return spec
    const result = yield* Effect.try({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      try: () => (spec as (args: { ctx: ExtensionSetupContext }) => unknown)({ ctx }),
      catch: (cause) =>
        new ExtensionLoadError({
          extensionId: manifest.id,
          message: `${field} factory threw: ${String(cause)}`,
          cause,
        }),
    })
    // Effect-typed factory: yield it AND seal its failure channel into
    // ExtensionLoadError. Without this, an Effect-factory could escape its
    // declared error channel (e.g. `Effect.fail("bad")` on `unknown` would
    // be propagated raw — loader.ts only catches defects). Codex C8 BLOCK 1.
    if (Effect.isEffect(result)) {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — runtime-loaded JS factory has erased E/R; mapError below re-seals into ExtensionLoadError, and Effect.isEffect proves the value is an Effect
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const erased = result as Effect.Effect<unknown, unknown>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — `erased` is intentionally typed `unknown,unknown`; sealed below converts the error channel to ExtensionLoadError via mapError
      const sealed = erased.pipe(
        Effect.mapError((cause) =>
          Schema.is(ExtensionLoadError)(cause)
            ? cause
            : new ExtensionLoadError({
                extensionId: manifest.id,
                message: `${field} factory failed: ${String(cause)}`,
                cause,
              }),
        ),
      )
      const value = yield* sealed
      if (!Array.isArray(value)) {
        return yield* new ExtensionLoadError({
          extensionId: manifest.id,
          message: `${field} factory must resolve to an array, got ${typeof value}`,
        })
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return value as ReadonlyArray<A>
    }
    // Sync factory: validate shape — a JS extension returning a single item
    // (`capabilities: () => myCap`) would otherwise silently become "no items"
    // because `undefined > 0` is false in the bucket-include check.
    if (!Array.isArray(result)) {
      return yield* new ExtensionLoadError({
        extensionId: manifest.id,
        message: `${field} factory must return an array, got ${typeof result}`,
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return result as ReadonlyArray<A>
  })

/**
 * Cross-bucket validation — runs after every bucket's spec resolves. Codex
 * C8 finding 4: field-local errors beat "_kind expected". The shape of the
 * messages is `Extension "@x" <field>[<i>] invalid: <reason>`.
 *
 * Invariants enforced here:
 *   - At most one Resource declares `machine` per extension. Without this,
 *     the runtime silently picks by array order and drops the rest.
 *   - Resource.machine must be process-scope until ephemeral composers wire
 *     Resource layers (codex BLOCK 3 on C3.5a).
 *   - Capability `audiences` must be non-empty.
 *   - `audiences:["model"]` capabilities must have a non-empty description
 *     (model-audience disclosure requirement; was activation.ts:282 check).
 *   - Intra-extension capability/agent/driver id/name collisions are
 *     surfaced (cross-extension collisions are scope-precedence's concern).
 */
const validateResources = (contribs: ExtensionContributions): string | undefined => {
  const machineResources = (contribs.resources ?? []).filter((r) => r.machine !== undefined)
  if (machineResources.length > 1) {
    return `resources: at most one Resource may declare \`machine\` (found ${machineResources.length}); the runtime would silently pick the first by array order and drop the rest`
  }
  const sessionScopedMachine = machineResources.find((r) => r.scope !== "process")
  if (sessionScopedMachine !== undefined) {
    return `resources: Resource.machine on scope "${sessionScopedMachine.scope}" is not yet supported (only "process" until per-cwd / ephemeral composers wire Resource layers). Move the machine to a process-scope Resource.`
  }
  return undefined
}

const validateCapabilities = (contribs: ExtensionContributions): string | undefined => {
  const capIds = new Map<string, number>()
  for (const [i, cap] of (contribs.capabilities ?? []).entries()) {
    if (cap.audiences === undefined || cap.audiences.length === 0) {
      return `capabilities[${i}] (${cap.id ?? "<no id>"}): \`audiences\` must be a non-empty array`
    }
    if (
      cap.audiences.includes("model") &&
      (cap.description === undefined || cap.description === "")
    ) {
      return `capabilities[${i}] (${cap.id}): model-audience capability requires a non-empty \`description\` (the model sees it as the tool description)`
    }
    if (capIds.has(cap.id)) {
      return `capabilities[${i}] (${cap.id}): duplicate id within extension (also at index ${capIds.get(cap.id)}); cross-extension collisions are resolved by scope precedence, but intra-extension collisions are an authoring bug`
    }
    capIds.set(cap.id, i)
  }
  return undefined
}

const validateAgents = (contribs: ExtensionContributions): string | undefined => {
  const agentNames = new Map<string, number>()
  for (const [i, a] of (contribs.agents ?? []).entries()) {
    if (agentNames.has(a.name)) {
      return `agents[${i}] (${a.name}): duplicate name within extension (also at index ${agentNames.get(a.name)})`
    }
    agentNames.set(a.name, i)
  }
  return undefined
}

const validateDriverIds = (contribs: ExtensionContributions): string | undefined => {
  const allDriverIds = new Map<string, string>()
  for (const [i, d] of (contribs.modelDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return `modelDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`
    }
    allDriverIds.set(d.id, `modelDrivers[${i}]`)
  }
  for (const [i, d] of (contribs.externalDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return `externalDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`
    }
    allDriverIds.set(d.id, `externalDrivers[${i}]`)
  }
  return undefined
}

const validatePackageShape = (
  manifest: ExtensionManifest,
  contribs: ExtensionContributions,
): Effect.Effect<void, ExtensionLoadError> =>
  Effect.gen(function* () {
    const checks = [validateResources, validateCapabilities, validateAgents, validateDriverIds]
    for (const check of checks) {
      const message = check(contribs)
      if (message !== undefined) {
        return yield* new ExtensionLoadError({ extensionId: manifest.id, message })
      }
    }
  })

/**
 * Define an extension as typed contribution buckets.
 *
 * Each bucket is optional and homogeneously typed. Buckets accept a literal
 * array (most common), a `(ctx) => array` factory, or a `(ctx) => Effect<array>`
 * factory. Errors during resolution are annotated with the bucket name.
 *
 * Cross-bucket validation runs after all buckets resolve — see
 * `validatePackageShape` for the enforced invariants.
 *
 * @example
 * ```ts
 * import { defineExtension, defineResource, tool } from "@gent/core/extensions/api"
 *
 * export const MyExt = defineExtension({
 *   id: "my-ext",
 *   resources: [defineResource({ scope: "process", layer: MyService.Live })],
 *   capabilities: [tool(MyTool)],
 * })
 * ```
 */
export const defineExtension = (params: DefineExtensionInput): GentExtension => {
  const manifest: ExtensionManifest = { id: params.id }
  return {
    manifest,
    setup: (ctx) =>
      Effect.gen(function* () {
        const resources = yield* resolveField(manifest, "resources", params.resources, ctx)
        const capabilities = yield* resolveField(manifest, "capabilities", params.capabilities, ctx)
        const agents = yield* resolveField(manifest, "agents", params.agents, ctx)
        const projections = yield* resolveField(manifest, "projections", params.projections, ctx)
        const pipelines = yield* resolveField(manifest, "pipelines", params.pipelines, ctx)
        const subscriptions = yield* resolveField(
          manifest,
          "subscriptions",
          params.subscriptions,
          ctx,
        )
        const modelDrivers = yield* resolveField(manifest, "modelDrivers", params.modelDrivers, ctx)
        const externalDrivers = yield* resolveField(
          manifest,
          "externalDrivers",
          params.externalDrivers,
          ctx,
        )
        const contribs: ExtensionContributions = {
          ...(resources.length > 0 ? { resources } : {}),
          ...(capabilities.length > 0 ? { capabilities } : {}),
          ...(agents.length > 0 ? { agents } : {}),
          ...(projections.length > 0 ? { projections } : {}),
          ...(pipelines.length > 0 ? { pipelines } : {}),
          ...(subscriptions.length > 0 ? { subscriptions } : {}),
          ...(modelDrivers.length > 0 ? { modelDrivers } : {}),
          ...(externalDrivers.length > 0 ? { externalDrivers } : {}),
          ...(params.pulseTags !== undefined && params.pulseTags.length > 0
            ? { pulseTags: params.pulseTags }
            : {}),
        }
        yield* validatePackageShape(manifest, contribs)
        return contribs
      }),
  }
}
