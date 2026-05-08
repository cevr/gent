/**
 * Shared in-process test layer for integration tests.
 * Provides a complete service graph that can be used with Gent.test().
 *
 * Import from @gent/core-internal/test-utils/in-process-layer.js
 */

import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import type { AgentDefinition } from "../domain/agent.js"
import { Auth } from "../domain/auth.js"
import { Permission } from "../domain/permission.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { DebugSlowLanguageModelDelayMs, LanguageModelLayers } from "./language-model.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { FallbackFileIndexLive } from "../runtime/file-index/index.js"
import { defineExtension } from "../extensions/api.js"
import { makeServerRootLayer } from "../server/server-root.js"

type HarnessProviderMode = "debug-scripted" | "debug-slow"

export interface InProcessLayerConfig {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

const buildLayer = (
  languageModelLive: Layer.Layer<LanguageModel.LanguageModel, never, never>,
  config: InProcessLayerConfig,
) => {
  const testAgentsExtension = defineExtension({
    id: "test-agents",
    agents: config.agents,
  })

  return makeServerRootLayer({
    dependencies: {
      cwd: "/tmp",
      home: "/tmp",
      platform: "test",
      persistenceMode: "memory",
      providerMode: "debug-scripted",
      languageModelLayerOverride: languageModelLive,
      extensions: [testAgentsExtension],
      overrides: {
        eventStoreMode: "storage-backed",
        authLayer: Auth.Test(),
        approvalLayer: ApprovalService.Test(),
        configServiceLayer: ConfigService.Test(),
        modelRegistryLayer: ModelRegistry.Test(),
        permissionLayer: Permission.Test(),
        toolRunnerLayer: ToolRunner.Test(),
        fileIndexLayer: Layer.provide(FallbackFileIndexLive, BunServices.layer),
        extraLayers: config.extraLayers,
      },
    },
    identity: {
      serverId: "test-server",
      pid: 0,
      hostname: "test-host",
      dbPath: ":memory:",
      buildFingerprint: "test-fingerprint",
      startedAt: 0,
    },
  }).pipe(Layer.provide(BunServices.layer))
}

/** Build a complete in-process test layer with a standard debug provider mode. */
export const baseLocalLayer = (
  config: InProcessLayerConfig,
  providerMode: HarnessProviderMode = "debug-scripted",
) =>
  buildLayer(
    providerMode === "debug-slow"
      ? LanguageModelLayers.debug({ delayMs: DebugSlowLanguageModelDelayMs })
      : LanguageModelLayers.debug(),
    config,
  )

/** Build a complete in-process test layer with a custom language model layer. */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel, never, never>,
  config: InProcessLayerConfig,
) => buildLayer(providerLayer, config)
