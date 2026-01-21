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

/** All supported providers */
export const providers = () => SUPPORTED_PROVIDERS

/** All available models */
export const models = () => DEFAULT_MODELS

/** Current generation models (latest per provider) */
const currentGenSet = new Set(CURRENT_GEN_MODEL_IDS as readonly string[])
export const currentGenModels = () => DEFAULT_MODELS.filter((m) => currentGenSet.has(m.id))

/** Models by provider */
export const modelsByProvider = (providerId: ProviderId) =>
  DEFAULT_MODELS.filter((m) => m.provider === providerId)

/** Current gen models by provider */
export const currentGenByProvider = (providerId: ProviderId) =>
  DEFAULT_MODELS.filter((m) => m.provider === providerId && currentGenSet.has(m.id))

/** Currently selected model ID for next message */
export const currentModel = _currentModel

/** Get info for selected model */
export const currentModelInfo = (): Model | undefined =>
  DEFAULT_MODELS.find((m) => m.id === _currentModel())

/** Set selected model for next message */
export const setModel = (modelId: ModelId) => {
  _setCurrentModel(modelId)
}

/** Initialize model state */
export const initModelState = (initialModel: ModelId) => {
  _setCurrentModel(initialModel)
}
