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
 *     const settings = yield* loadSettings(host.cwd)
 *     yield* host.register("tool", ProjectTool(settings))
 *   }),
 * })
 * ```
 *
 * @module
 */
import { Effect } from "effect"
import { ExtensionId } from "../domain/ids.js"
import {
  type ExtensionHost,
  ExtensionLoadError,
  type ExtensionManifest,
  type GentExtension,
} from "../domain/extension.js"

// ── Re-exports for extension authors ──

// Tool execution receives params only; host authority is imported through the
// constrained `ExtensionContext` service.
export {
  AgentDefinition,
  AgentName,
  ReasoningEffort,
  type RunSpec,
  RunOverrides,
} from "../domain/agent.js"
export {
  type GentExtension,
  LoadedArtifactIdentity,
  type ToolCallInput,
  type TurnAfterInput,
  type TurnUsage,
} from "../domain/extension.js"
export {
  acceptedEfforts,
  credentialFailureMetadata,
  DEFAULT_RETRY_POLICY,
  DriverError,
  ProviderAuthError,
  ProviderAuthInfo,
  rateLimitResponse,
  ReasoningOption,
  reportProviderStopReason,
  retryAfterAt,
  modelFromCatalog,
  catalogModelEntry,
} from "../domain/driver.js"
export { InteractionPendingError } from "../domain/interaction.js"
export type {
  ApiClassContribution,
  ApiClassRequest,
  ApiEndpoint,
  CatalogModel,
  CatalogOverride,
  CatalogPlan,
  CatalogProvider,
  FailureResponse,
  ModelCatalogView,
  ModelDriverContribution,
  ModelRouteChoice,
  ModelRouteCurrent,
  ModelRouteDecision,
  ModelRouteInput,
  ModelRouterContribution,
  VirtualModel,
  VirtualModelProblem,
  ProviderAuthorizationResult,
  ProviderHints,
  RunEffort,
  StoredOAuthCredentials,
  UpdateStoredOAuth,
} from "../domain/driver.js"
export {
  ActorCommandId,
  SessionId,
  BranchId,
  MessageId,
  ToolCallId,
  RequestId,
  ExtensionId,
} from "../domain/ids.js"
// The message a `steer` send lands; `Session.stopMessage({ messageId })` names it.
export { interjectionMessageId } from "../domain/agent-loop.js"
export { clampEffort, Model, ModelId, type ModelPricing, ProviderId } from "../domain/agent.js"
// What a prompt-cache write costs and how long it lives: a router prices a switch with them.
export { cacheWriteRate, promptCacheTtlMsFor } from "../domain/agent.js"
export { AuthMethod } from "../domain/driver.js"
// The assistant message a turn's step stores; `StreamStarted` names the turn and step.
export {
  type Message,
  type Branch,
  assistantMessageIdForTurn,
  DEFAULT_SESSION_NAME,
} from "../domain/message.js"
export type { AgentEvent } from "../domain/event.js"
export {
  isRuntimeUserMessage,
  isSpawnedSession,
  latestAssistantText,
  messagePartsDisplayText,
  sessionThread,
} from "../domain/message.js"
export {
  // Smart constructor — returns a bare leaf value; the bucket it's placed
  // in is the discrimination (no `_kind` field).
  defineResource,
  // The branch a branch Resource builds for.
  BranchAddress,
} from "../domain/extension.js"

// Typed capability factories. Extension registries dispatch by factory-origin
// metadata baked into the lowering.
//
// See `domain/capability.ts` for the typed shapes.
export {
  AGENT_PROMPT_PRIORITY,
  getToolId,
  getToolPrompt,
  tool,
  ToolCallVerdict,
  type ToolInput,
  type ToolCapability,
} from "../domain/capability.js"
export { defineRequests, ref, request, type RequestInput } from "../domain/capability.js"
export type { CapabilityRef } from "../domain/capability.js"
export { ToolResultFailure } from "../domain/message.js"
export {
  ExtensionContext,
  ExtensionServiceError,
  ExtensionStatus,
  type ExtensionContextService,
  type ExtensionModelsService,
} from "../domain/extension.js"
export { isRecord, isRecordArray, type JsonRecord, omitUndefined } from "../domain/guards.js"
// Runs a command to completion over the Effect `ChildProcessSpawner`.
export {
  ProcessError,
  resolveDataDir,
  runProcess,
  writeFileAtomic,
} from "../runtime/gent-platform.js"
export { headChars, headTailChars, lineCount, splitLines, tailChars } from "../domain/message.js"
export { maximumModelToolResultChars } from "../runtime/model-context.js"
// A tool hands the model an image by reference: save its bytes, put the `ToolImage` in the output.
export { saveToolImage, ToolImage, ToolImageError, toolImageFile } from "../runtime/tool-image.js"
// Launched from home, the project's `.gent` is the user's; every reader of project files asks this.
// A project file whose entries run commands or spend on models counts only in a trusted project.
export { hasProjectScope, isProjectTrusted } from "../runtime/config.js"
// A config file's schema: an extension that writes a config refuses a file gent would not read.
export { UserConfig } from "../runtime/config.js"
// ── Public API ──

export { ExtensionHost, type ExtensionHostService } from "../domain/extension.js"

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
