/**
 * In-process integration layer: the E2E root with the stub tool runner and
 * a scripted or slow debug model. Use with `Gent.test()`.
 *
 * Import from @gent/core-internal/test-utils/in-process-layer.js
 */

import type { LanguageModel } from "effect/unstable/ai"
import type { Layer } from "effect"
import type { AgentDefinition } from "../domain/agent.js"
import { DebugSlowLanguageModelDelayMs, LanguageModelLayers } from "./language-model.js"
import type { BranchToolFeature } from "../runtime/agent/branch-tool-feature.js"
import { createE2ELayer } from "./e2e-layer.js"

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

/** Build a complete in-process test layer with a custom language model layer. */
export const baseLocalLayerWithProvider = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel, never, never>,
  config: InProcessLayerConfig,
) =>
  createE2ELayer({
    providerLayer,
    agents: config.agents,
    extensions: [],
    extensionInputs: [],
    branchTools: config.branchTools,
    extraLayers: config.extraLayers,
    toolRunner: "test",
  })

/** Build a complete in-process test layer with a standard debug provider mode. */
export const baseLocalLayer = (
  config: InProcessLayerConfig,
  providerMode: HarnessProviderMode = "debug-scripted",
) => {
  if (providerMode === "debug-slow") {
    return baseLocalLayerWithProvider(
      LanguageModelLayers.debug({ delayMs: DebugSlowLanguageModelDelayMs }),
      config,
    )
  }
  return baseLocalLayerWithProvider(LanguageModelLayers.debug(), config)
}
