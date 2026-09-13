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
import { DebugSlowLanguageModelDelayMs, LanguageModelLayers } from "./language-model.js"
import { ToolRunner } from "../runtime/agent/tool-runner.js"
import { makeServerRootLayer } from "../server/server-root.js"
import { noBranchTools, type BranchToolFeature } from "../runtime/agent/branch-tool-feature.js"
import { testAgentsExtension, testEnvironment, testIdentity, testOverrides } from "./test-root.js"

type HarnessProviderMode = "debug-scripted" | "debug-slow"

export interface InProcessLayerConfig {
  /**
   * The branch-tool feature this harness installs. Defaults to
   * `noBranchTools`; a test exercising a real feature names it.
   */
  readonly branchTools?: BranchToolFeature<never>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly extraLayers?: ReadonlyArray<Layer.Layer<never>>
}

const buildLayer = (
  languageModelLive: Layer.Layer<LanguageModel.LanguageModel, never, never>,
  config: InProcessLayerConfig,
) =>
  makeServerRootLayer({
    dependencies: {
      ...testEnvironment,
      persistenceMode: "memory",
      providerMode: "debug-scripted",
      languageModelLayerOverride: languageModelLive,
      extensions: [testAgentsExtension(config.agents)],
      branchTools: config.branchTools ?? noBranchTools,
      overrides: {
        ...testOverrides(),
        eventStoreMode: "storage-backed",
        toolRunnerLayer: ToolRunner.Test(),
        extraLayers: config.extraLayers,
      },
    },
    identity: testIdentity(),
  }).pipe(Layer.provide(BunServices.layer))

/** Build a complete in-process test layer with a standard debug provider mode. */
export const baseLocalLayer = (
  config: InProcessLayerConfig,
  providerMode: HarnessProviderMode = "debug-scripted",
) => {
  if (providerMode === "debug-slow") {
    return buildLayer(LanguageModelLayers.debug({ delayMs: DebugSlowLanguageModelDelayMs }), config)
  }
  return buildLayer(LanguageModelLayers.debug(), config)
}

/** Build a complete in-process test layer with a custom language model layer. */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel, never, never>,
  config: InProcessLayerConfig,
) => buildLayer(providerLayer, config)
