/**
 * E2E test layer with queued event publishing and tool execution.
 *
 * Unlike baseLocalLayerWithProvider (which stubs everything), this layer wires the
 * prod-shaped event publisher, real ToolRunner.Live, and direct session-loop
 * follow-ups — so QueueFollowUp actually drives multi-turn loops.
 *
 * Import from @gent/core-internal/test-utils/e2e-layer
 */

import { Effect, Layer, Ref } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BunServices } from "@effect/platform-bun"
import {
  AgentName,
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_MODEL_ID,
  type AgentDefinition,
  type AgentRunner,
} from "../domain/agent.js"
import { Auth } from "../domain/auth.js"
import type { ExtensionSetupContext, GentExtension, LoadedExtension } from "../domain/extension.js"
import { type ExtensionContributions, defineResource } from "../domain/contribution.js"
import type { EventPublisher } from "../domain/event-publisher.js"
import { SessionId, type ExtensionId, type InteractionRequestId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { MODEL_CONTEXT_WINDOWS } from "../runtime/context-estimation.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import type { SessionProfileCache } from "../runtime/session-profile.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"
import { defineExtension } from "../extensions/api.js"
import { makeServerRootLayer } from "../server/server-root.js"

export interface E2ELayerConfig {
  /** Language model layer — typically from `LanguageModelLayers.sequence` */
  readonly providerLayer: Layer.Layer<LanguageModel.LanguageModel>
  /** Agents to register in the extension registry */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extension inputs for setup */
  readonly extensionInputs: ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>>
  /** Pre-loaded extensions to wire directly (bypasses setup). Mutually exclusive with extensionInputs. */
  readonly extensions?: ReadonlyArray<LoadedExtension>
  /** AgentRunner mock. Default: returns success with empty text */
  readonly subagentRunner?: AgentRunner
  /** Approval service override. Default auto-approves for E2E tests. */
  readonly approvalLayer?: Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform>
  /** Use the production cold-interaction service with durable pending rows. */
  readonly durableApproval?: boolean
  /** File-backed SQLite path for restart/recovery tests. Defaults to in-memory SQLite. */
  readonly storagePath?: string
  /** Optional per-cwd profile cache for shared-server routing tests. */
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
  /** Auth override. Use for public RPC auth failure-path tests. */
  readonly authLayer?: Layer.Layer<Auth>
  /**
   * ConfigService override. Default is `ConfigService.Test()`.
   * Provide `ConfigService.Live` (or a custom layer) to exercise per-cwd
   * config resolution — e.g., for driver-override-from-session-cwd tests.
   */
  readonly configServiceLayer?: Layer.Layer<ConfigService>
  /** Per-extension layer overrides (e.g., memory vault test layer) */
  readonly layerOverrides?: Record<string, () => Layer.Layer<never>>
}

const defaultSubagentRunner: AgentRunner = {
  run: () =>
    Effect.succeed(
      AgentRunResult.cases.success.make({
        text: "",
        sessionId: SessionId.make("test-subagent-session"),
        agentName: AgentName.make("cowork"),
      }),
    ),
}

const applyLayerOverride = (
  contributions: ExtensionContributions,
  extensionId: ExtensionId,
  override: (() => Layer.Layer<never>) | undefined,
): ExtensionContributions => {
  if (override === undefined) return contributions
  const processResources = (contributions.resources ?? []).filter((r) => r.scope === "process")
  if (processResources.length > 1) {
    throw new Error(
      `e2e-layer.layerOverrides: extension "${extensionId}" has ${processResources.length} process-scope Resources; the override path replaces all of them with one merged layer. Provide a complete merged layer in the override factory, or extend layerOverrides to address Resources individually.`,
    )
  }
  const rawOverrideLayer = override()
  type TestOverrideLayer = Layer.Layer<unknown, unknown, never>
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const overrideLayer = rawOverrideLayer as unknown as TestOverrideLayer // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
  const layerOverride = defineResource({
    scope: "process",
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    layer: overrideLayer,
  })
  const otherResources = (contributions.resources ?? []).filter((r) => r.scope !== "process")
  return {
    ...contributions,
    resources: [...otherResources, layerOverride],
  }
}

const testAgentsExtension = (agents: ReadonlyArray<AgentDefinition>) =>
  defineExtension({
    id: "test-agents",
    agents,
  })

const fromLoadedExtension = (extension: LoadedExtension): GentExtension<never> => ({
  manifest: extension.manifest,
  setup: () => Effect.succeed(extension.contributions),
})

const wrapExtensionInput = (
  extension: GentExtension<ChildProcessSpawner | GentPlatform>,
  layerOverrides: E2ELayerConfig["layerOverrides"],
): GentExtension<ChildProcessSpawner | GentPlatform> => ({
  manifest: extension.manifest,
  setup: (ctx: ExtensionSetupContext) =>
    extension
      .setup(ctx)
      .pipe(
        Effect.map((contributions) =>
          applyLayerOverride(
            contributions,
            extension.manifest.id,
            layerOverrides?.[extension.manifest.id],
          ),
        ),
      ),
})

const extensionInputsForConfig = (
  config: E2ELayerConfig,
): ReadonlyArray<GentExtension<ChildProcessSpawner | GentPlatform>> =>
  config.extensions === undefined
    ? config.extensionInputs.map((extension) =>
        wrapExtensionInput(extension, config.layerOverrides),
      )
    : [testAgentsExtension(config.agents), ...config.extensions.map(fromLoadedExtension)]

const approvalOverrideForConfig = (config: E2ELayerConfig) => {
  if (config.approvalLayer !== undefined) return config.approvalLayer
  if (config.durableApproval === true) return undefined
  return ApprovalService.Test()
}

/**
 * Build a complete E2E test layer with queued event publishing.
 *
 * The harness is a production-root preset: extension setup, resource startup,
 * event publishing, interaction recovery, and session runtime wiring flow
 * through `createDependencies`/`buildServerRoot`.
 */
export const createE2ELayer = (config: E2ELayerConfig) => {
  const subagentRunnerLayer = Layer.succeed(
    AgentRunnerService,
    config.subagentRunner ?? defaultSubagentRunner,
  )

  return makeServerRootLayer({
    dependencies: {
      cwd: "/tmp",
      home: "/tmp",
      platform: "test",
      persistenceMode: config.storagePath === undefined ? "memory" : "disk",
      ...(config.storagePath !== undefined ? { dbPath: config.storagePath } : {}),
      languageModelLayerOverride: config.providerLayer,
      extensions: extensionInputsForConfig(config),
      overrides: {
        eventStoreMode: "storage-backed",
        authLayer: config.authLayer ?? Auth.Test(),
        approvalLayer: approvalOverrideForConfig(config),
        configServiceLayer: config.configServiceLayer ?? ConfigService.Test(),
        modelRegistryLayer: ModelRegistry.Test(),
        permissionLayer: Permission.Test(),
        sessionProfileCacheLayer: config.sessionProfileCacheLayer,
        fileIndexLayer: Layer.provide(FallbackFileIndexLive, BunServices.layer),
        extraLayers: [subagentRunnerLayer, ...(config.extraLayers ?? [])],
      },
    },
    identity: {
      serverId: "test-server",
      pid: 0,
      hostname: "test-host",
      dbPath: config.storagePath ?? ":memory:",
      buildFingerprint: "test-fingerprint",
      startedAt: 0,
    },
  }).pipe(Layer.provide(BunServices.layer))
}

// ── Test helpers ──

/**
 * Temporarily shrink the context window for the default model so that
 * even small messages exceed the handoff threshold (85%).
 *
 * With 5000-token window and 4000-token system overhead, any message
 * content pushes context past 85%. Restores the original value via
 * Effect.ensuring, safe against test failures.
 *
 * Usage:
 * ```ts
 * yield* withTinyContextWindow(Effect.gen(function* () { ... }))
 * ```
 */
export const withTinyContextWindow = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const originalWindow = MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID]
  return Effect.suspend(() => {
    MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID] = 5_000
    return effect
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (originalWindow !== undefined) {
          MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID] = originalWindow
        } else {
          delete MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID]
        }
      }),
    ),
  )
}

/**
 * ApprovalService that tracks whether present() was called.
 *
 * Returns a Layer + a Ref<boolean> that flips to true if present() fires.
 * Always resolves with approved=true so tests don't hang.
 *
 * Usage:
 * ```ts
 * const { layer, presentCalled } = yield* trackingApprovalService()
 * // ... provide layer ...
 * expect(yield* Ref.get(presentCalled)).toBe(false)
 * ```
 */
export const trackingApprovalService = () =>
  Effect.gen(function* () {
    const presentCalled = yield* Ref.make(false)
    const layer = Layer.succeed(ApprovalService, {
      present: () => Ref.set(presentCalled, true).pipe(Effect.as({ approved: true })),
      pendingRequestId: () => Effect.sync((): InteractionRequestId | undefined => undefined),
      storeResolution: () => Effect.void,
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    })
    return { layer, presentCalled }
  })
