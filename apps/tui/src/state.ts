/**
 * Global model state for UI selection
 * Selected model is sent with messages to server
 */
import { createSignal } from "solid-js"
import {
  type ModelId,
  type Model,
  type ProviderId,
  DEFAULT_MODELS,
  SUPPORTED_PROVIDERS,
  CURRENT_GEN_MODEL_IDS,
  DEFAULT_MODEL_ID,
} from "@gent/core"

// =============================================================================
// Model State (UI selection)
// =============================================================================

const [_currentModel, _setCurrentModel] = createSignal<ModelId>(DEFAULT_MODEL_ID)
const [_models, _setModels] = createSignal<readonly Model[]>(DEFAULT_MODELS)
const [_currentGenIds, _setCurrentGenIds] = createSignal<ReadonlySet<string>>(
  new Set(CURRENT_GEN_MODEL_IDS as readonly string[]),
)

/** All supported providers */
export const providers = () => SUPPORTED_PROVIDERS

/** All available models (reactive - can include custom providers) */
export const models = _models

/** Current generation models (latest per provider) */
export const currentGenModels = () => {
  const genSet = _currentGenIds()
  return _models().filter((m) => genSet.has(m.id))
}

/** Models by provider */
export const modelsByProvider = (providerId: ProviderId | string) =>
  _models().filter((m) => m.provider === providerId)

/** Current gen models by provider */
export const currentGenByProvider = (providerId: ProviderId | string) => {
  const genSet = _currentGenIds()
  return _models().filter((m) => m.provider === providerId && genSet.has(m.id))
}

/** Currently selected model ID for next message */
export const currentModel = _currentModel

/** Get info for selected model */
export const currentModelInfo = (): Model | undefined =>
  _models().find((m) => m.id === _currentModel())

/** Set selected model for next message */
export const setModel = (modelId: ModelId) => {
  _setCurrentModel(modelId)
}

/** Initialize model state */
export const initModelState = (initialModel: ModelId) => {
  _setCurrentModel(initialModel)
}

/** Initialize model registry from server (called by ClientProvider) */
export const initModelRegistry = (models: readonly Model[]) => {
  _setModels(models)
  // Update current gen set based on new models
  // Keep the same IDs that are in CURRENT_GEN_MODEL_IDS + add any custom models
  const builtinCurrentGen = new Set(CURRENT_GEN_MODEL_IDS as readonly string[])
  // Include custom provider models as "current gen" by default
  const customIds = models
    .filter((m) => !DEFAULT_MODELS.some((d) => d.id === m.id))
    .map((m) => m.id)
  const allCurrentGen = new Set([...builtinCurrentGen, ...customIds])
  _setCurrentGenIds(allCurrentGen)
}
