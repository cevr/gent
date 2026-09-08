/**
 * E2E test layer with queued event publishing and tool execution.
 *
 * Unlike baseLocalLayerWithProvider (which stubs everything), this layer wires the
 * prod-shaped event publisher, real ToolRunner.Live, and direct session-loop
 * follow-ups — so QueueFollowUp actually drives multi-turn loops.
 *
 * Import from @gent/core-internal/test-utils/e2e-layer
 */

import { Predicate, Effect, Layer, Option, Ref } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import {
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_MODEL_ID,
  type AgentDefinition,
  type AgentRunner,
  DEFAULT_AGENT_NAME,
} from "../domain/agent.js"
import { Auth } from "../domain/auth.js"
import type { GentExtension, LoadedExtension, ExtensionSetupServices } from "../domain/extension.js"
import { type ExtensionContributions, defineResource } from "../domain/contribution.js"
import type { EventPublisher } from "../domain/event-publisher.js"
import { SessionId, type ExtensionId } from "../domain/ids.js"
import { Permission } from "../domain/permission.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { MODEL_CONTEXT_WINDOWS } from "../runtime/context-estimation.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import type { SessionProfileCache } from "../runtime/session-profile.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"
import { defineExtension, ExtensionHost } from "../extensions/api.js"
import { makeCollectingExtensionHost, registerContributions } from "../domain/extension-host.js"
import { testHostFacts } from "./index.js"
import { makeServerRootLayer } from "../server/server-root.js"

export interface E2ELayerConfig {
  /** Language model layer — typically from `LanguageModelLayers.sequence` */
  readonly providerLayer: Layer.Layer<LanguageModel.LanguageModel>
  /** Agents to register in the extension registry */
  readonly agents: ReadonlyArray<AgentDefinition>
  /** Extension inputs for setup */
  readonly extensionInputs: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /** Pre-loaded extensions to wire directly (bypasses setup). Mutually exclusive with extensionInputs. */
  readonly extensions?: ReadonlyArray<LoadedExtension>
  /** Use "live" for real child sessions. Default mocks blocking run only. */
  readonly subagentRunner?: "live" | Pick<AgentRunner, "run">
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

const defaultSubagentRunner: Pick<AgentRunner, "run"> = {
  run: () =>
    Effect.succeed(
      AgentRunResult.cases.success.make({
        text: "",
        sessionId: SessionId.make("test-subagent-session"),
        agentName: DEFAULT_AGENT_NAME,
      }),
    ),
}

const applyLayerOverride = (
  contributions: ExtensionContributions,
  extensionId: ExtensionId,
  override: Option.Option<() => Layer.Layer<never>>,
): ExtensionContributions => {
  if (Option.isNone(override)) return contributions
  const processResources = (contributions.resources ?? []).filter((r) => r.scope === "process")
  if (processResources.length > 1) {
    return Effect.runSync(
      Effect.die(
        new Error(
          `e2e-layer.layerOverrides: extension "${extensionId}" has ${processResources.length} process-scope Resources; the override path replaces all of them with one merged layer. Provide a complete merged layer in the override factory, or extend layerOverrides to address Resources individually.`,
        ),
      ),
    )
  }
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The test override erases resource output types at this heterogeneous layer boundary.
  const overrideLayer = override.value() as unknown as Layer.Layer<unknown, never, never>
  const layerOverride = defineResource({
    id: "test/e2e-layer/process-override",
    scope: "process",
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
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register("agent", ...agents)
    }),
  })

const fromLoadedExtension = (
  extension: LoadedExtension,
): GentExtension<ExtensionSetupServices> => ({
  manifest: extension.manifest,
  artifactIdentity: extension.artifactIdentity,
  setup: registerContributions(extension.contributions),
})

const wrapExtensionInput = (
  extension: GentExtension<ExtensionSetupServices>,
  layerOverrides: E2ELayerConfig["layerOverrides"],
): GentExtension<ExtensionSetupServices> => ({
  manifest: extension.manifest,
  artifactIdentity: extension.artifactIdentity,
  setup: Effect.gen(function* () {
    const collector = makeCollectingExtensionHost(testHostFacts())
    yield* extension.setup.pipe(Effect.provideService(ExtensionHost, collector.service))
    const contributions = yield* collector.seal
    yield* registerContributions(
      applyLayerOverride(
        contributions,
        extension.manifest.id,
        Option.fromUndefinedOr(layerOverrides?.[extension.manifest.id]),
      ),
    )
  }),
})

const extensionInputsForConfig = (
  config: E2ELayerConfig,
): ReadonlyArray<GentExtension<ExtensionSetupServices>> => {
  if (Predicate.isUndefined(config.extensions)) {
    return config.extensionInputs.map((extension) =>
      wrapExtensionInput(extension, config.layerOverrides),
    )
  }
  return [testAgentsExtension(config.agents), ...config.extensions.map(fromLoadedExtension)]
}

const approvalOverrideForConfig = (config: E2ELayerConfig) => {
  if (!Predicate.isUndefined(config.approvalLayer)) return Option.some(config.approvalLayer)
  if (config.durableApproval === true) return Option.none()
  return Option.some(ApprovalService.Test())
}

/**
 * Build a complete E2E test layer with queued event publishing.
 *
 * The harness is a production-root preset: extension setup, resource startup,
 * event publishing, interaction recovery, and session runtime wiring flow
 * through `createDependencies`/`buildServerRoot`.
 */
export const createE2ELayer = (config: E2ELayerConfig) => {
  let subagentRunnerLayer = Option.none<Layer.Layer<AgentRunnerService>>()
  if (config.subagentRunner !== "live") {
    subagentRunnerLayer = Option.some(
      Layer.succeed(
        AgentRunnerService,
        AgentRunnerService.of({
          start: () => Effect.die("AgentRunner.start not configured in test"),
          inspect: () => Effect.die("AgentRunner.inspect not configured in test"),
          list: () => Effect.die("AgentRunner.list not configured in test"),
          cancel: () => Effect.die("AgentRunner.cancel not configured in test"),
          ...(config.subagentRunner ?? defaultSubagentRunner),
        }),
      ),
    )
  }

  return makeServerRootLayer({
    dependencies: {
      cwd: "/tmp",
      home: "/tmp",
      platform: "test",
      persistenceMode: Option.fromUndefinedOr(config.storagePath).pipe(
        Option.match({ onNone: () => "memory", onSome: () => "disk" }),
      ),
      dbPath: config.storagePath,
      languageModelLayerOverride: config.providerLayer,
      extensions: extensionInputsForConfig(config),
      overrides: {
        eventStoreMode: "storage-backed",
        authLayer: config.authLayer ?? Auth.Test(),
        approvalLayer: Option.getOrUndefined(approvalOverrideForConfig(config)),
        configServiceLayer: config.configServiceLayer ?? ConfigService.Test(),
        modelRegistryLayer: ModelRegistry.Test(),
        permissionLayer: Permission.Test(),
        sessionProfileCacheLayer: config.sessionProfileCacheLayer,
        fileIndexLayer: Layer.provide(FallbackFileIndexLive, BunServices.layer),
        agentRunnerLayer: Option.getOrUndefined(subagentRunnerLayer),
        extraLayers: config.extraLayers,
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
 * yield* Effect.gen(function* () { ... }).pipe(provideTinyContextWindow)
 * ```
 */
export const provideTinyContextWindow = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const originalWindow = MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID]
  return Effect.suspend(() => {
    MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID] = 5_000
    return effect
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!Predicate.isUndefined(originalWindow)) {
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
 * const { layer, presentCalled } = yield* trackingApprovalService
 * // ... provide layer ...
 * expect(yield* Ref.get(presentCalled)).toBe(false)
 * ```
 */
export const trackingApprovalService = Effect.gen(function* () {
  const presentCalled = yield* Ref.make(false)
  const layer = Layer.succeed(
    ApprovalService,
    ApprovalService.of({
      present: () => Ref.set(presentCalled, true).pipe(Effect.as({ approved: true })),
      pendingRequestId: () => Effect.undefined,
      storeResolution: () => Effect.void,
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    }),
  )
  return { layer, presentCalled }
})
