/**
 * Extension authoring API.
 *
 * Single entry point: `defineExtension({ id, resources?, tools?, actions?, requests?, ... })`.
 * The factory accepts typed sub-arrays (literal arrays OR `(ctx) => array` OR
 * `(ctx) => Effect<array>` per bucket), validates them, and produces a
 * `GentExtension` whose `setup()` returns `ExtensionContributions` buckets.
 *
 * The bucket name IS the discrimination — TypeScript catches a command
 * placed in `tools` at the call site; runtime package-shape validation adds
 * field-local error messages for runtime-loaded (JS) extensions.
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
 *   tools: [tool(MyTool)],
 * })
 * ```
 *
 * @example with ctx + Effect
 * ```ts
 * export default defineExtension({
 *   id: "my-ext",
 *   tools: ({ ctx }) =>
 *     Effect.gen(function* () {
 *       const skills = yield* loadSkills(ctx.cwd)
 *       return [tool(SearchSkillsTool(skills))]
 *     }),
 * })
 * ```
 *
 * @module
 */
import { Effect } from "effect"
import { ExtensionId } from "../domain/ids.js"
import { ExtensionLoadError } from "../domain/extension.js"
import { sealRuntimeLoadedEffect } from "../domain/extension-load-boundary.js"
import type {
  GentExtension,
  ExtensionSetupContext,
  ExtensionManifest,
} from "../domain/extension.js"
import type { ExtensionContributions, ExtensionReactions } from "../domain/contribution.js"
import type { AgentDefinition } from "../domain/agent.js"
import type { ActionCapability } from "../domain/capability/action.js"
import type { RequestCapability } from "../domain/capability/request.js"
import type { ToolCapability } from "../domain/capability/tool.js"
import {
  validateExtensionPackageShape,
  validateKnownExtensionInputBuckets,
} from "../domain/extension-package-shape.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../domain/driver.js"
import type { AnyResourceContribution } from "../domain/resource.js"
import type { AgentEvent } from "../domain/event.js"

// ── Re-exports for full-power extension authors ──

// `ToolCapabilityContext` (re-exported via the second `domain/capability/tool`
// block below) is the execution context passed to a tool's `execute(...)` body
// — the wide host context with `toolCallId` narrowed to required.
export {
  LOCK_REGISTRY,
  ToolNeeds,
  type ToolNeed,
  type ToolNeedAccess,
  type ToolNeedTag,
} from "../domain/capability/tool.js"
export {
  defineAgent,
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DriverRef,
  ModelDriverRef,
  ExternalDriverRef,
  makeRunSpec,
  RunSpecSchema,
  AgentRunOverridesSchema,
  AgentRunResult as AgentRunResultSchema,
  AgentRunToolCallSchema,
  type AgentRunOverrides,
  resolveRunPersistence,
  getDurableAgentRunSessionId,
  AgentRunError,
  type AgentRunResult,
  type RunSpec,
} from "../domain/agent.js"
export {
  type GentExtension,
  type ProjectionTurnContext,
  type TurnProjection,
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
export type { PromptSection } from "../domain/prompt.js"
export {
  sectionStartMarker,
  sectionEndMarker,
  sectionPatternFor,
  withSectionMarkers,
} from "../domain/prompt.js"
export type { TurnExecutor, TurnContext, TurnStreamPart } from "../domain/driver.js"
export { ProviderAuthError, TurnError } from "../domain/driver.js"
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
  type AgentEventTag,
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
export {
  SessionId,
  BranchId,
  TaskId,
  ArtifactId,
  MessageId,
  ToolCallId,
  ExtensionId,
} from "../domain/ids.js"
export { Model, ModelId } from "../domain/model.js"
export { Task, TaskStatus, TaskTransitionError, isValidTaskTransition } from "../domain/task.js"
export { AuthMethod, AuthOauth } from "../domain/auth.js"
export {
  dateFromMillis,
  type Message,
  type MessagePart,
  MessageMetadata,
  type Branch,
} from "../domain/message.js"
export {
  messagePartImage,
  messagePartReasoning,
  messagePartSearchText,
  messagePartText,
  messagePartToolCall,
  messagePartToolResult,
  messagePartsDisplayText,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsReasoningLines,
  messagePartsSearchText,
  messagePartsText,
  messagePartsTextLines,
  messagePartsToolCalls,
  messagePartsToolResults,
  stringifySearchValue,
  type ImagePartProjection,
  type MessagePartsDisplayTextOptions,
  type ToolCallPartProjection,
  type ToolResultPartProjection,
} from "../domain/message-part-projection.js"
export { PermissionRule, type PermissionResult } from "../domain/permission.js"
export { OutputBuffer, saveFullOutput, headTailChars } from "../domain/output-buffer.js"
export {
  ExtensionHostError,
  ExtensionHostSearchResult,
  type ExtensionHostContext,
} from "../domain/extension-host-context.js"
export { isRecord, isRecordArray } from "../domain/guards.js"
export { TaggedEnumClass } from "../domain/schema-tagged-enum-class.js"
export { FileIndex } from "../domain/file-index.js"
export { FileLockService } from "../domain/file-lock.js"
export { ExtensionEventSink } from "../domain/event-publisher.js"
export type { ExtensionEventSinkService } from "../domain/event-publisher.js"
export {
  type ExtensionContributions,
  type ExtensionReactions,
  // Smart constructor — returns a bare leaf value; the bucket it's placed
  // in is the discrimination (no `_kind` field).
  defineResource,
  resource,
} from "../domain/contribution.js"

// Typed capability factories. Extension registries dispatch by factory-origin
// metadata baked into the lowering.
//
// See `domain/capability/{tool,request,action}.ts` for the typed shapes.
export {
  getToolId,
  tool,
  type ToolCapabilityContext,
  type GentToolMetadata,
  type ToolInput,
  type ToolCapability,
} from "../domain/capability/tool.js"
export {
  ref,
  request,
  type ReadRequestInput,
  type RequestCapability,
  type WriteRequestInput,
} from "../domain/capability/request.js"
export {
  action,
  type ActionInput,
  type ActionSurface,
  type ActionCapability,
} from "../domain/capability/action.js"
export type {
  CapabilityContext,
  CapabilityCoreContext,
  ModelCapabilityContext,
  CapabilityRef,
} from "../domain/capability.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"
export type {
  ResourceContribution,
  AnyResourceContribution,
  ResourceSpec,
  ResourceScope,
  ScopeOf,
  ResourceSchedule,
} from "../domain/resource.js"
export { ProjectionError } from "../domain/projection-error.js"

// `ReadOnly` brand — type-level fence. Author services that should only
// be reachable from projections / read-intent capabilities by branding
// their Tag's inner shape with `ReadOnly<MyServiceShape>`. Use
// `withReadOnly(value)` to apply the brand at the Live layer construction
// site. See `domain/read-only.ts` for usage.
export {
  type ReadOnly,
  type ReadOnlyTag,
  ReadOnlyBrand,
  withReadOnly,
} from "../domain/read-only.js"
export { runProcess, ProcessError } from "../utils/run-process.js"
export type { ProcessResult, RunProcessOptions } from "../utils/run-process.js"
export { GentPlatform } from "../runtime/gent-platform.js"
export type { GentPlatformShape } from "../runtime/gent-platform.js"
export { ToolRunner } from "../runtime/agent/tool-runner.js"
export type { ToolRunnerService } from "../runtime/agent/tool-runner.js"

// ── Public API ──

// ExtensionSetupContext re-exported from domain — single source of truth
export type { ExtensionSetupContext } from "../domain/extension.js"

/**
 * Per-bucket spec accepted by `defineExtension`. Each bucket field can be:
 *   - a literal array (90% of cases — the extension contributes a constant set)
 *   - a `(args) => array` factory (when the bucket needs `ctx` but no Effect)
 *   - a `(args) => Effect<array>` factory (when setup needs Effect-typed work)
 *
 * Codex  review: prefer literal arrays as default; the variance behind one
 * helper (`resolveField`) keeps 26 of 30 builtin extensions ceremony-free
 * while preserving Effect for the 4 that genuinely need it.
 */
export type FieldSpec<A> =
  | ReadonlyArray<A>
  | ((args: {
      readonly ctx: ExtensionSetupContext
    }) => ReadonlyArray<A> | Effect.Effect<ReadonlyArray<A>, ExtensionLoadError>)

export interface DefineExtensionInput<Client = unknown> {
  readonly id: string
  /**
   * Optional client-side facet owned by the same extension artifact.
   *
   * Core keeps this intentionally opaque: the server loader ignores it, while
   * clients that know their UI runtime can lower it into their local
   * contribution shape. This lets one conceptual extension carry one id and
   * one server/client pairing without making core depend on a TUI package.
   */
  readonly client?: Client
  readonly resources?: FieldSpec<AnyResourceContribution>
  /**
   * LLM-callable tools authored via `tool({...})`. The bucket name is the
   * dispatch surface: every entry must be a `ToolCapability` — `request({...})`
   * and `action({...})` outputs cannot be slotted here.
   */
  readonly tools?: FieldSpec<ToolCapability>
  /**
   * Human-driven UI commands authored via `action({...})`. The bucket name is
   * the dispatch surface: every entry must be an `ActionCapability` — `tool({...})`
   * and `request({...})` outputs cannot be slotted here.
   */
  readonly actions?: FieldSpec<ActionCapability>
  /**
   * Extension-to-extension RPC capabilities authored via `request({...})`.
   * The bucket name is the dispatch surface: every entry must be a
   * `RequestCapability` — `tool({...})` and `action({...})` outputs cannot be
   * slotted here.
   */
  readonly requests?: FieldSpec<RequestCapability>
  readonly agents?: FieldSpec<AgentDefinition>
  /**
   * Lifecycle reactions: `turnBefore` / `turnAfter` / `messageOutput` /
   * `toolResult` handlers run by the runtime. Per-extension, per-session.
   * Compiled by `compileExtensionReactions`.
   */
  readonly reactions?: ExtensionReactions
  readonly modelDrivers?: FieldSpec<ModelDriverContribution>
  readonly externalDrivers?: FieldSpec<ExternalDriverContribution>
}

/**
 * Resolve a single bucket field — accepts literal array, sync factory, or
 * Effect-returning factory. Errors are annotated with the bucket name so
 * the failure message points at the field, not "setup failed" (codex
 *  finding 2).
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
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
    // be propagated raw — loader.ts only catches defects). Codex  BLOCK 1.
    if (Effect.isEffect(result)) {
      const value = yield* sealRuntimeLoadedEffect({
        extensionId: manifest.id,
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        effect: () => result,
        failureMessage: (cause) => `${field} factory failed: ${String(cause)}`,
        defectMessage: (cause) => `${field} factory defect: ${String(cause)}`,
      })
      if (!Array.isArray(value)) {
        return yield* new ExtensionLoadError({
          extensionId: manifest.id,
          message: `${field} factory must resolve to an array, got ${typeof value}`,
        })
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
      return value as ReadonlyArray<A>
    }
    // Sync factory: validate shape — a JS extension returning a single item
    // (`tools: () => myCap`) would otherwise silently become "no items"
    // because `undefined > 0` is false in the bucket-include check.
    if (!Array.isArray(result)) {
      return yield* new ExtensionLoadError({
        extensionId: manifest.id,
        message: `${field} factory must return an array, got ${typeof result}`,
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
    return result as ReadonlyArray<A>
  })

/**
 * Define an extension as typed contribution buckets.
 *
 * Each bucket is optional and homogeneously typed. Buckets accept a literal
 * array (most common), a `(ctx) => array` factory, or a `(ctx) => Effect<array>`
 * factory. Errors during resolution are annotated with the bucket name.
 *
 * Cross-bucket validation runs after all buckets resolve.
 *
 * @example
 * ```ts
 * import { defineExtension, defineResource, tool } from "@gent/core/extensions/api"
 *
 * export const MyExt = defineExtension({
 *   id: "my-ext",
 *   resources: [defineResource({ scope: "process", layer: MyService.Live })],
 *   tools: [tool(MyTool)],
 * })
 * ```
 */
export function defineExtension(
  params: DefineExtensionInput & { readonly client?: undefined },
): GentExtension
export function defineExtension<Client>(
  params: DefineExtensionInput<Client> & { readonly client: Client },
): GentExtension & { readonly client: Client }
export function defineExtension<Client>(
  params: DefineExtensionInput<Client>,
): GentExtension & { readonly client?: Client }
export function defineExtension(
  params: DefineExtensionInput,
): GentExtension & { readonly client?: unknown } {
  const manifest: ExtensionManifest = { id: ExtensionId.make(params.id) }
  return {
    manifest,
    ...(params.client !== undefined ? { client: params.client } : {}),
    setup: (ctx) =>
      Effect.gen(function* () {
        const inputMessage = validateKnownExtensionInputBuckets(params)
        if (inputMessage !== undefined) {
          return yield* new ExtensionLoadError({ extensionId: manifest.id, message: inputMessage })
        }
        const resources = yield* resolveField(manifest, "resources", params.resources, ctx)
        const tools = yield* resolveField(manifest, "tools", params.tools, ctx)
        const actions = yield* resolveField(manifest, "actions", params.actions, ctx)
        const requests = yield* resolveField(manifest, "requests", params.requests, ctx)
        const agents = yield* resolveField(manifest, "agents", params.agents, ctx)
        const modelDrivers = yield* resolveField(manifest, "modelDrivers", params.modelDrivers, ctx)
        const externalDrivers = yield* resolveField(
          manifest,
          "externalDrivers",
          params.externalDrivers,
          ctx,
        )
        const contribs: ExtensionContributions = {
          ...(resources.length > 0 ? { resources } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(actions.length > 0 ? { actions } : {}),
          ...(requests.length > 0 ? { requests } : {}),
          ...(agents.length > 0 ? { agents } : {}),
          ...(params.reactions !== undefined ? { reactions: params.reactions } : {}),
          ...(modelDrivers.length > 0 ? { modelDrivers } : {}),
          ...(externalDrivers.length > 0 ? { externalDrivers } : {}),
        }
        yield* validateExtensionPackageShape(manifest, contribs)
        return contribs
      }),
  }
}
