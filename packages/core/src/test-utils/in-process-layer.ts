/**
 * In-process integration layer: the E2E root with the stub tool runner and
 * the scripted debug model. Use with `Gent.test()`.
 *
 * Import from @gent/core-internal/test-utils/in-process-layer.js
 */

import type { LanguageModel } from "effect/unstable/ai"
import type { Layer } from "effect"
import type { AgentDefinition } from "../domain/agent.js"
import { LanguageModelLayers } from "./language-model.js"
import { createE2ELayer } from "./e2e-layer.js"

interface InProcessLayerConfig {
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
    extraLayers: config.extraLayers,
    toolRunner: "test",
  })

/** Build a complete in-process test layer with the scripted debug model. */
export const baseLocalLayer = (config: InProcessLayerConfig) =>
  baseLocalLayerWithProvider(LanguageModelLayers.debug(), config)
