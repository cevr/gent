/**
 * E2E test layer with queued event publishing and tool execution.
 *
 * Unlike baseLocalLayerWithProvider (which stubs everything), this layer wires the
 * prod-shaped event publisher, real ToolRunner.Live, and direct session-loop
 * follow-ups — so QueueFollowUp actually drives multi-turn loops.
 *
 * Import from @gent/core-internal/test-utils/e2e-layer
 */

import { Predicate, Effect, Layer, Option } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import type { AgentDefinition, AgentRunner, AgentRunnerService } from "../domain/agent.js"
import { Auth } from "../domain/auth.js"
import {
  defineResource,
  type ExtensionContributions,
  type ExtensionSetupServices,
  type GentExtension,
  type LoadedExtension,
  makeCollectingExtensionHost,
  registerContributions,
} from "../domain/extension.js"
import type { EventPublisher } from "../domain/event.js"
import type { ExtensionId } from "../domain/ids.js"
import { ApprovalService } from "../runtime/approval-service.js"
import type { InteractionStorage } from "../storage/storage.js"
import { ConfigService } from "../runtime/config-service.js"
import type { GentPlatform } from "../runtime/gent-platform.js"
import type { SessionProfileCache } from "../runtime/session-profile.js"
import { ExtensionHost } from "../extensions/api.js"
import { testHostFacts } from "./index.js"
import { buildServerRoot } from "../server/server-root.js"
import { StateLocation } from "../server/dependencies.js"
import { type BranchToolFeature, noBranchTools, ToolRunner } from "../runtime/agent/tools.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import {
  stubAgentRunnerLayer,
  testAgentsExtension,
  testEnvironment,
  testIdentity,
} from "./test-root.js"

export interface E2ELayerConfig {
  /**
   * The branch-tool feature this harness installs. Defaults to
   * `noBranchTools`; a test exercising a real feature names it.
   */
  readonly branchTools?: BranchToolFeature<never>
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
  readonly approvalLayer?: Layer.Layer<
    ApprovalService,
    never,
    EventPublisher | GentPlatform | InteractionStorage
  >
  /** Use the production cold-interaction service with durable pending rows. */
  readonly durableApproval?: boolean
  /** File-backed SQLite path for restart/recovery tests. Defaults to in-memory SQLite. */
  readonly storagePath?: string
  /** Optional per-cwd profile cache for shared-server routing tests. */
  readonly sessionProfileCacheLayer?: Layer.Layer<SessionProfileCache>
  /** Extra layers to merge (e.g., additional service overrides) */
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
  /** `"test"` installs the stub tool runner; default runs the live one. */
  readonly toolRunner?: "test" | "live"
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
    subagentRunnerLayer = Option.some(stubAgentRunnerLayer(config.subagentRunner))
  }
  let toolRunnerLayer = Option.none<Layer.Layer<ToolRunner>>()
  if (config.toolRunner === "test") toolRunnerLayer = Option.some(ToolRunner.Test())

  const root = buildServerRoot({
    observability: Layer.empty,
    dependencies: {
      ...testEnvironment,
      state: Option.match(Option.fromUndefinedOr(config.storagePath), {
        onNone: () => StateLocation.cases.Memory.make({}),
        onSome: (dbPath) => StateLocation.cases.Disk.make({ dbPath }),
      }),
      languageModelLayerOverride: config.providerLayer,
      extensions: extensionInputsForConfig(config),
      branchTools: config.branchTools ?? noBranchTools,
      overrides: {
        modelRegistryLayer: ModelRegistry.Test(),
        authLayer: config.authLayer ?? Auth.Test(),
        approvalLayer: Option.getOrUndefined(approvalOverrideForConfig(config)),
        configServiceLayer: config.configServiceLayer ?? ConfigService.Test(),
        sessionProfileCacheLayer: config.sessionProfileCacheLayer,
        agentRunnerLayer: Option.getOrUndefined(subagentRunnerLayer),
        toolRunnerLayer: Option.getOrUndefined(toolRunnerLayer),
        extraLayers: config.extraLayers,
      },
    },
    identity: testIdentity(config.storagePath),
  })
  return Layer.unwrap(root.pipe(Effect.map((built) => built.coreServicesLive))).pipe(
    Layer.provide(BunServices.layer),
  )
}
