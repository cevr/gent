/**
 * Extension authoring API.
 *
 * Single entry point: `defineExtension({ id, setup })`. `setup` is an Effect
 * that yields `ExtensionHost` and registers leaves with
 * `host.register(domain, ...values)` and hooks with `host.on(kind, handler)`.
 * The loader collects the registrations, validates them, and seals them into
 * the extension's contributions.
 *
 * Effect-native end-to-end: setup, tools, requests, and hooks are Effects.
 * There are no Promise edges — gent is a library used inside Effect programs.
 *
 * @example
 * ```ts
 * import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api"
 *
 * export default defineExtension({
 *   id: "my-ext",
 *   setup: Effect.gen(function* () {
 *     const host = yield* ExtensionHost
 *     yield* host.register("resource", defineResource({ id: "my-ext/service", scope: "process", layer: MyService.Live }))
 *     yield* host.register("tool", MyTool)
 *     yield* host.on("turnAfter", (input) => Effect.log(input.durationMs))
 *   }),
 * })
 * ```
 *
 * @example with setup facts
 * ```ts
 * export default defineExtension({
 *   id: "my-ext",
 *   setup: Effect.gen(function* () {
 *     const host = yield* ExtensionHost
 *     const skills = yield* loadSkills(host.cwd)
 *     yield* host.register("tool", SearchSkillsTool(skills))
 *   }),
 * })
 * ```
 *
 * @module
 */
import { Effect } from "effect"
import { ExtensionId } from "../domain/ids.js"
import {
  ExtensionLoadError,
  type GentExtension,
  type ExtensionManifest,
} from "../domain/extension.js"
import type { ExtensionHost } from "../domain/extension-host.js"

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
  ChildAgentRegistryEntry,
  getDurableAgentRunSessionId,
  AgentRunError,
  type RunSpec,
  resolveDefaultAgentModel,
} from "../domain/agent.js"
export { requireAgent, requireCurrentAgent } from "../domain/extension-services.js"
export {
  type GentExtension,
  LoadedArtifactIdentity,
  type TurnProjection,
  type SystemPromptInput,
  type ToolCallInput,
  type ToolCallPreflightResult,
  type TurnAfterInput,
  type ToolResultInput,
  hook,
  type AnyExtensionHook,
  type ExtensionHook,
  type ExtensionHookSlot,
} from "../domain/extension.js"
export type { LoadedArtifactIdentity as ExtensionArtifactIdentity } from "../domain/extension.js"
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
  RequestId,
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
  // Smart constructor — returns a bare leaf value; the bucket it's placed
  // in is the discrimination (no `_kind` field).
  defineResource,
  defineStateResource,
  type ExtensionState,
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
  defineRequests,
  ref,
  request,
  type RequestInput,
  type RequestCapability,
} from "../domain/capability/request.js"
export type { CapabilityRef } from "../domain/capability.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"
export { ToolResultFailure } from "../domain/tool-output.js"
export type { ResourceContribution, AnyResourceContribution } from "../domain/resource.js"
export type { ScheduledJobContribution } from "../domain/scheduled-job.js"
export { ProjectionError } from "../domain/extension.js"
export {
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
} from "../domain/extension-services.js"
export { ResourceId, ResourceRevision } from "../domain/resource-graph.js"
export { DynamicExtensionRegistry } from "../domain/dynamic-extension-registry.js"
export type { DynamicRegistrationScope } from "../domain/dynamic-extension-registry.js"
export { isRecord, isRecordArray } from "../domain/guards.js"
export { OutputBuffer, headTailChars, saveFullOutput } from "../domain/output-buffer.js"
// ── Public API ──

export {
  ExtensionHost,
  registrationDomains,
  type ExtensionHostService,
  type RegistrationDomain,
  type RegistrationValue,
} from "../domain/extension-host.js"

interface DefineExtensionInput<R = never> {
  readonly id: string
  /**
   * Registers leaves and hooks through `yield* ExtensionHost`. Failures are
   * `ExtensionLoadError`; the loader seals defects into the same error.
   */
  readonly setup: Effect.Effect<void, ExtensionLoadError, R>
}

/**
 * Define an extension: a stable id plus one `setup` Effect that registers
 * through `ExtensionHost`.
 */
export const defineExtension = <R = ExtensionHost>(
  params: DefineExtensionInput<R>,
): GentExtension<R> => {
  const manifest: ExtensionManifest = { id: ExtensionId.make(params.id) }
  // JavaScript callers get no type check; an old bucket key must fail loudly
  // instead of being dropped.
  const unknownKeys = Object.keys(params).filter((key) => !DEFINE_EXTENSION_KEYS.has(key))
  if (unknownKeys.length > 0) {
    return {
      manifest,
      setup: Effect.fail(
        new ExtensionLoadError({
          extensionId: manifest.id,
          message: `unknown defineExtension key "${unknownKeys[0]}"; contributions are registered inside setup with \`yield* ExtensionHost\``,
        }),
      ),
    }
  }
  return { manifest, setup: params.setup }
}

const DEFINE_EXTENSION_KEYS = new Set(["id", "setup"])
