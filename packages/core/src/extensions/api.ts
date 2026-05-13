/**
 * Extension authoring API.
 *
 * Single entry point: `defineExtension({ id, resources?, tools?, requests?, ... })`.
 * The factory accepts typed sub-arrays (literal arrays OR `() => array` OR
 * `() => Effect<array>` per bucket), validates them, and produces a
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
 * @example with setup facts + Effect
 * ```ts
 * export default defineExtension({
 *   id: "my-ext",
 *   tools: () =>
 *     Effect.gen(function* () {
 *       const ctx = yield* ExtensionSetupContext
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
import type { GentExtension, ExtensionManifest } from "../domain/extension.js"
import type { ExtensionSetupContext } from "../domain/extension-setup-context.js"
import type { ExtensionContributions, ExtensionReactions } from "../domain/contribution.js"
import type { AgentDefinition } from "../domain/agent.js"
import type { RequestCapability } from "../domain/capability/request.js"
import type { ToolCapability } from "../domain/capability/tool.js"
import {
  validateExtensionPackageShape,
  validateKnownExtensionInputBuckets,
} from "../domain/extension-package-shape.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../domain/driver.js"
import type { AnyResourceContribution } from "../domain/resource.js"
import type { ScheduledJobContribution } from "../domain/scheduled-job.js"

// ── Re-exports for extension authors ──

// Tool execution receives params only; host authority is imported through the
// constrained `ExtensionContext` service.
export {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DriverRef,
  ModelDriverRef,
  ExternalDriverRef,
  makeRunSpec,
  RunSpecSchema,
  AgentRunResult,
  AgentRunToolCallSchema,
  getDurableAgentRunSessionId,
  AgentRunError,
  type RunSpec,
  resolveDualModelPair,
  NoModeledAgentsError,
} from "../domain/agent.js"
export { requireAgent, estimateContextPercent } from "../domain/extension-services.js"
export {
  type GentExtension,
  type TurnProjection,
  type SystemPromptInput,
  type TurnAfterInput,
  type ToolResultInput,
} from "../domain/extension.js"
export type { PromptSection } from "../domain/prompt.js"
export { sectionPatternFor, withSectionMarkers } from "../domain/prompt.js"
export { ExternalToolRunner } from "../domain/driver.js"
export type { TurnExecutor, TurnContext, TurnStreamPart } from "../domain/driver.js"
export { ProviderAuthError, TurnError } from "../domain/driver.js"
export { InteractionPendingError } from "../domain/interaction-request.js"
export type {
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
  SessionId,
  BranchId,
  MessageId,
  ToolCallId,
  ExtensionId,
  ArtifactId,
} from "../domain/ids.js"
export { Model, ModelId } from "../domain/model.js"
export { AuthMethod, AuthOauth } from "../domain/auth.js"
export {
  DateFromNumber,
  dateFromMillis,
  type Message,
  type MessagePart,
  type Branch,
} from "../domain/message.js"
export type { Question } from "../domain/event.js"
export {
  messagePartImage,
  messagePartReasoning,
  messagePartText,
  messagePartToolCall,
  messagePartsDisplayText,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsReasoningLines,
  messagePartsSearchText,
  messagePartsText,
  messagePartsTextLines,
  messagePartsToolCalls,
  messagePartsToolResults,
} from "../domain/message-part-projection.js"
export { PermissionRule, type PermissionResult } from "../domain/permission.js"
export {
  type ExtensionContributions,
  type ExtensionReactions,
  // Smart constructor — returns a bare leaf value; the bucket it's placed
  // in is the discrimination (no `_kind` field).
  defineResource,
} from "../domain/contribution.js"

// Typed capability factories. Extension registries dispatch by factory-origin
// metadata baked into the lowering.
//
// See `domain/capability/{tool,request}.ts` for the typed shapes.
export {
  getToolId,
  tool,
  type GentToolMetadata,
  type ToolInput,
  type ToolCapability,
} from "../domain/capability/tool.js"
export {
  ref,
  request,
  type RequestInput,
  type RequestCapability,
} from "../domain/capability/request.js"
export type { CapabilityRef } from "../domain/capability.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"
export type { ResourceContribution, AnyResourceContribution } from "../domain/resource.js"
export type { ScheduledJobContribution } from "../domain/scheduled-job.js"
export { ProjectionError } from "../domain/extension.js"
export {
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
} from "../domain/extension-services.js"
export { isRecord, isRecordArray } from "../domain/guards.js"
export { OutputBuffer, headTailChars, saveFullOutput } from "../domain/output-buffer.js"
// ── Public API ──

/**
 * Per-bucket spec accepted by `defineExtension`. Each bucket field can be:
 *   - a literal array (90% of cases — the extension contributes a constant set)
 *   - a `() => array` factory (when the bucket wants lazy construction)
 *   - a `() => Effect<array>` factory (when setup needs facts/services)
 *
 * Factful setup uses `yield* ExtensionSetupContext`; setup facts are provided
 * by `defineExtension` and do not leak into the loaded extension dependency
 * type.
 */
type FieldSpec<A, R = never> =
  | ReadonlyArray<A>
  | (() => ReadonlyArray<A> | Effect.Effect<ReadonlyArray<A>, ExtensionLoadError, R>)

export {
  ExtensionSetupContext,
  type PublicExtensionSetupContext,
} from "../domain/extension-setup-context.js"

type RemainingSetupRequirements<R> = Exclude<R, ExtensionSetupContext>

interface DefineExtensionInput<R = never> {
  readonly id: string
  readonly resources?: FieldSpec<AnyResourceContribution, R>
  readonly scheduledJobs?: FieldSpec<ScheduledJobContribution, R>
  /**
   * LLM-callable tools authored via `tool({...})`. The bucket name is the
   * dispatch surface: every entry must be a `ToolCapability` — `request({...})`
   * outputs cannot be slotted here.
   */
  readonly tools?: FieldSpec<ToolCapability, R>
  /**
   * Extension-to-extension RPC capabilities authored via `request({...})`.
   * The bucket name is the dispatch surface: every entry must be a
   * `RequestCapability` — `tool({...})` outputs cannot be slotted here.
   * Slash commands are requests carrying a `slash:` presentation block.
   */
  readonly requests?: FieldSpec<RequestCapability, R>
  readonly agents?: FieldSpec<AgentDefinition, R>
  /**
   * Lifecycle reactions: `systemPrompt` / `turnProjection` / `turnAfter` /
   * `toolResult` handlers run by the runtime. Per-extension, per-session.
   * Compiled by `compileExtensionReactions`.
   */
  readonly reactions?: ExtensionReactions
  readonly modelDrivers?: FieldSpec<ModelDriverContribution, R>
  readonly externalDrivers?: FieldSpec<ExternalDriverContribution, R>
}

/**
 * Resolve a single bucket field — accepts literal array, sync factory, or
 * Effect-returning factory. Errors are annotated with the bucket name so
 * the failure message points at the field, not "setup failed" (codex
 *  finding 2).
 */
const resolveField = <A, R>(
  manifest: ExtensionManifest,
  field: string,
  spec: FieldSpec<A, R> | undefined,
): Effect.Effect<
  ReadonlyArray<A>,
  ExtensionLoadError,
  RemainingSetupRequirements<R> | ExtensionSetupContext
> =>
  Effect.gen(function* () {
    if (spec === undefined) return []
    if (typeof spec !== "function") return spec
    const result: ReadonlyArray<A> | Effect.Effect<ReadonlyArray<A>, ExtensionLoadError, R> =
      yield* Effect.try({
        try: () => spec(),
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
    // be propagated raw — loader.ts only catches defects). The
    // `ExtensionSetupContext` Tag stays in the R channel — the loader
    // provides it at the outer setup boundary.
    if (Effect.isEffect(result)) {
      const sealed: Effect.Effect<
        ReadonlyArray<unknown>,
        ExtensionLoadError,
        RemainingSetupRequirements<R> | ExtensionSetupContext
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- seal returns Effect<A,_,R> from inferred R; widen to surface the loader-provided ExtensionSetupContext requirement at the bucket boundary
      > = sealRuntimeLoadedEffect({
        extensionId: manifest.id,
        effect: () => result,
        failureMessage: (cause) => `${field} factory failed: ${String(cause)}`,
        defectMessage: (cause) => `${field} factory defect: ${String(cause)}`,
      }) as Effect.Effect<
        ReadonlyArray<unknown>,
        ExtensionLoadError,
        RemainingSetupRequirements<R> | ExtensionSetupContext
      >
      const value = yield* sealed
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
 * array (most common), a `() => array` factory, or a `() => Effect<array>`
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
export function defineExtension<R = never>(
  params: DefineExtensionInput<R>,
): GentExtension<RemainingSetupRequirements<R>>
export function defineExtension<R>(
  params: DefineExtensionInput<R>,
): GentExtension<RemainingSetupRequirements<R>> {
  const manifest: ExtensionManifest = { id: ExtensionId.make(params.id) }
  return {
    manifest,
    setup: Effect.gen(function* () {
      const inputMessage = validateKnownExtensionInputBuckets(params)
      if (inputMessage !== undefined) {
        return yield* new ExtensionLoadError({ extensionId: manifest.id, message: inputMessage })
      }
      const resources = yield* resolveField(manifest, "resources", params.resources)
      const scheduledJobs = yield* resolveField(manifest, "scheduledJobs", params.scheduledJobs)
      const tools = yield* resolveField(manifest, "tools", params.tools)
      const requests = yield* resolveField(manifest, "requests", params.requests)
      const agents = yield* resolveField(manifest, "agents", params.agents)
      const modelDrivers = yield* resolveField(manifest, "modelDrivers", params.modelDrivers)
      const externalDrivers = yield* resolveField(
        manifest,
        "externalDrivers",
        params.externalDrivers,
      )
      const contribs: ExtensionContributions = {
        ...(resources.length > 0 ? { resources } : {}),
        ...(scheduledJobs.length > 0 ? { scheduledJobs } : {}),
        ...(tools.length > 0 ? { tools } : {}),
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
