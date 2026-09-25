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
  makeRunSpec,
  type RunSpec,
  RunSpecSchema,
} from "../domain/agent.js"
export {
  type GentExtension,
  LoadedArtifactIdentity,
  type SystemPromptInput,
  type TurnAfterInput,
  type TurnUsage,
} from "../domain/extension.js"
export {
  credentialFailureMetadata,
  DEFAULT_RETRY_POLICY,
  ProviderAuthError,
  ProviderAuthInfo,
  reportProviderStopReason,
} from "../domain/driver.js"
export { type ApprovalDecision, InteractionPendingError } from "../domain/interaction.js"
export type {
  ModelDriverContribution,
  ProviderAuthorizationResult,
  ProviderHints,
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
export { Model, ModelId, type ModelPricing, ProviderId } from "../domain/agent.js"
export { AuthMethod } from "../runtime/provider.js"
// The assistant message a turn's step stores; `StreamStarted` names the turn and step.
export { type Message, type Branch, assistantMessageIdForTurn } from "../domain/message.js"
export type { AgentEvent, Question } from "../domain/event.js"
export {
  isRuntimeUserMessage,
  isSpawnedSession,
  latestAssistantText,
  messagePartsDisplayText,
} from "../domain/message.js"
export {
  // Smart constructor — returns a bare leaf value; the bucket it's placed
  // in is the discrimination (no `_kind` field).
  defineResource,
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
  type ToolInput,
  type ToolCapability,
} from "../domain/capability.js"
export {
  defineRequests,
  ref,
  request,
  type RequestCapability,
  type RequestInput,
} from "../domain/capability.js"
export type { CapabilityRef } from "../domain/capability.js"
export { CapabilityError } from "../domain/capability.js"
export { ToolResultFailure } from "../domain/message.js"
export {
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
} from "../domain/extension.js"
export { isRecord, isRecordArray, omitUndefined } from "../domain/guards.js"
// Runs a command to completion over the Effect `ChildProcessSpawner`.
export {
  ProcessError,
  resolveDataDir,
  runProcess,
  writeFileAtomic,
} from "../runtime/gent-platform.js"
export { headTailChars, lineCount, splitLines } from "../domain/message.js"
export { maximumModelToolResultChars } from "../runtime/model-context.js"
// Launched from home, the project's `.gent` is the user's; every reader of project files asks this.
export { hasProjectScope } from "../runtime/config.js"
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
