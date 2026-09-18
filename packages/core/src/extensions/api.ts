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
  ExternalDriverRef,
  makeRunSpec,
  RunSpecSchema,
  AgentRunResult,
  AgentRunToolCallSchema,
  ChildAgentRegistryEntry,
  AgentRunError,
} from "../domain/agent.js"
export { requireCurrentAgent } from "../domain/extension-services.js"
export {
  type AnyExtensionHook,
  type GentExtension,
  LoadedArtifactIdentity,
  type SystemPromptInput,
  type TurnAfterInput,
  hook,
} from "../domain/extension.js"
export type { TurnExecutor, TurnContext, TurnStreamPart } from "../domain/driver.js"
export { DEFAULT_RETRY_POLICY, ProviderAuthError, TurnError } from "../domain/driver.js"
export { InteractionPendingError } from "../domain/interaction-request.js"
export type {
  ModelDriverContribution,
  ProviderAuthInfo,
  ProviderAuthorizationResult,
  ProviderHints,
  ProviderResolution,
} from "../domain/driver.js"
export {
  SessionId,
  BranchId,
  MessageId,
  ToolCallId,
  RequestId,
  ExtensionId,
} from "../domain/ids.js"
export { Model, ModelId } from "../domain/agent.js"
export { AuthMethod } from "../domain/auth.js"
export { type Message, type Branch } from "../domain/message.js"
export type { Question } from "../domain/event.js"
export { messagePartsDisplayText } from "../domain/message.js"
export {
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
  getToolPrompt,
  tool,
  type ToolInput,
  type ToolCapability,
} from "../domain/capability/tool.js"
export {
  defineRequests,
  ref,
  request,
  type RequestCapability,
  type RequestInput,
} from "../domain/capability/request.js"
export type { CapabilityRef } from "../domain/capability.js"
export { CapabilityError } from "../domain/capability.js"
export { ToolResultFailure } from "../domain/message.js"
export {
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
} from "../domain/extension-services.js"
export { isRecord, isRecordArray, omitUndefined } from "../domain/guards.js"
export { headTailChars } from "../domain/message.js"
export { maximumModelToolResultChars } from "../providers/ai-transcript.js"
// ── Public API ──

export { ExtensionHost, type ExtensionHostService } from "../domain/extension-host.js"

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
