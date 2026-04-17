/**
 * Extension authoring API.
 *
 * Single entry point: `defineExtension({ id, contributions })`. The factory
 * receives the setup context and returns a flat `Contribution[]` (or an
 * Effect that yields one). Smart constructors (`toolContribution`,
 * `agentContribution`, `defineResource`, etc.) are re-exported from
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
 *   defineResource,
 *   defineTool,
 *   toolContribution,
 * } from "@gent/core/extensions/api"
 *
 * export default defineExtension({
 *   id: "my-ext",
 *   contributions: () => [
 *     toolContribution(MyTool),
 *     defineResource({ scope: "process", layer: MyService.Live }),
 *   ],
 * })
 * ```
 *
 * @module
 */
import { Effect } from "effect"
import { ExtensionLoadError } from "../domain/extension.js"
import type { GentExtension, ExtensionSetupContext } from "../domain/extension.js"
import { type Contribution, filterByKind } from "../domain/contribution.js"
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
  defineInterceptor,
  type ExtensionInterceptorDescriptor,
  type ExtensionInterceptorKey,
  type ExtensionInterceptorMap,
  type ExtensionActorDefinition,
  type AnyExtensionActorDefinition,
  type TurnProjection,
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
  type CommandKindContribution,
  type ModelDriverKindContribution,
  type ExternalDriverKindContribution,
  type PermissionRuleContribution,
  type PromptSectionContribution,
  type ProjectionKindContribution,
  type QueryKindContribution,
  type MutationKindContribution,
  type CapabilityKindContribution,
  filterByKind,
  // smart constructors
  tool as toolContribution,
  agent as agentContribution,
  interceptor as interceptorContribution,
  command as commandContribution,
  modelDriver as modelDriverContribution,
  externalDriver as externalDriverContribution,
  permissionRule as permissionRuleContribution,
  promptSection as promptSectionContribution,
  projection as projectionContribution,
  pulseSubscription as pulseSubscriptionContribution,
  query as queryContribution,
  mutation as mutationContribution,
  capability as capabilityContribution,
  defineResource,
  defineLifecycleResource,
} from "../domain/contribution.js"
export type {
  CapabilityContribution,
  AnyCapabilityContribution,
  CapabilityContext,
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
// ── Removed in Phase 6 / B2 ──
//
// `LoweredBuckets`, `placeContribution`, `bucketsToSetup`, `lowerContributions`,
// and the `ExtensionSetup` setup-bag interface are gone. The canonical
// `Contribution[]` flows through `LoadedExtension.contributions` and every
// registry/runtime consumer reads it directly via the `extractX` helpers in
// `domain/contribution.ts`. There is one shape, one place, one source of truth.

// ── Public API ──

// ExtensionSetupContext re-exported from domain — single source of truth
export type { ExtensionSetupContext } from "../domain/extension.js"

/**
 * Define an extension as a flat array of contributions.
 *
 * The canonical authoring shape — no fluent chain, no setup bag. The factory
 * receives the setup context and returns a `Contribution[]` (or an Effect
 * that yields one). Later scope wins per the registry's scope precedence rule.
 *
 * Validates the single-machine constraint: an extension may declare at most
 * one `Resource` with a `machine`.
 *
 * @example
 * ```ts
 * import { defineExtension, defineResource, toolContribution } from "@gent/core/extensions/api"
 *
 * export const MyExt = defineExtension({
 *   id: "my-ext",
 *   contributions: ({ ctx }) => [
 *     defineResource({ scope: "process", layer: MyService.Live }),
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
      // Guard the synchronous factory call so author throws surface as typed
      // ExtensionLoadError rather than fiber defects. Direct `ext.setup(...)`
      // callers (tests, programmatic uses) get the same typed-failure shape
      // as the loader's `setupExtension` defect-catching path.
      const result = yield* Effect.try({
        try: () => params.contributions({ ctx }),
        catch: (cause) =>
          new ExtensionLoadError({
            extensionId: params.id,
            message: `Contribution factory threw: ${String(cause)}`,
            cause,
          }),
      })
      const contribs: ReadonlyArray<Contribution> = Effect.isEffect(result) ? yield* result : result
      const resourcesWithMachine = filterByKind(contribs, "resource").filter(
        (r) => r.machine !== undefined,
      )
      // At most one machine per extension. Without this check the runtime
      // silently picks the first Resource by array order and drops the second
      // machine's protocols / mappers / effects on the floor.
      if (resourcesWithMachine.length > 1) {
        return yield* new ExtensionLoadError({
          extensionId: params.id,
          message: "extension may declare at most one Resource with `machine`",
        })
      }
      // Codex BLOCK 3 on C3.5a: today only process-scope Resource layers flow
      // into the layer composition root (`profile.ts > buildExtensionLayers`).
      // A `Resource.machine` on a session/branch-scope Resource would have its
      // services unavailable to the machine at spawn time. The plan's eventual
      // resting place is session/branch scope, but until the per-cwd /
      // ephemeral composers are wired (C3 successor work), constrain to
      // process scope so the failure is at setup time, not at first transition.
      const sessionScopedMachine = resourcesWithMachine.find((r) => r.scope !== "process")
      if (sessionScopedMachine !== undefined) {
        return yield* new ExtensionLoadError({
          extensionId: params.id,
          message: `Resource.machine on scope "${sessionScopedMachine.scope}" is not yet supported (only "process" until per-cwd / ephemeral composers wire Resource layers). Move the machine to a process-scope Resource, or wait for the C3 successor work.`,
        })
      }
      return contribs
    }),
})
