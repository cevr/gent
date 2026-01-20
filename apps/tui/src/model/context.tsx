import { createContext, useContext, onMount } from "solid-js"
import type { JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Model, ModelId, Provider, ProviderId } from "@gent/core"
import { DEFAULT_MODELS, SUPPORTED_PROVIDERS, CURRENT_GEN_MODEL_IDS } from "@gent/core"

interface ModelContextValue {
  providers: () => readonly Provider[]
  models: () => readonly Model[]
  currentGenModels: () => readonly Model[]
  modelsByProvider: (providerId: ProviderId) => readonly Model[]
  currentGenByProvider: (providerId: ProviderId) => readonly Model[]
  currentModel: () => ModelId
  currentModelInfo: () => Model | undefined
  setModel: (modelId: ModelId) => void
  ready: boolean
}

const ModelContext = createContext<ModelContextValue>()

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelContext)
  if (!ctx) throw new Error("useModel must be used within ModelProvider")
  return ctx
}

interface ModelProviderProps {
  initialModel: ModelId
  onModelChange?: ((modelId: ModelId) => void) | undefined
  children: JSX.Element
}

export function ModelProvider(props: ModelProviderProps) {
  const [store, setStore] = createStore({
    providers: SUPPORTED_PROVIDERS as readonly Provider[],
    models: DEFAULT_MODELS as readonly Model[],
    currentModel: props.initialModel,
    ready: true,
  })

  onMount(() => {
    // Future: fetch from ModelRegistry service
    // For now using defaults
  })

  const currentGenSet = new Set(CURRENT_GEN_MODEL_IDS as readonly string[])

  const value: ModelContextValue = {
    providers: () => store.providers,
    models: () => store.models,
    currentGenModels: () => store.models.filter((m) => currentGenSet.has(m.id)),
    modelsByProvider: (providerId: ProviderId) =>
      store.models.filter((m) => m.provider === providerId),
    currentGenByProvider: (providerId: ProviderId) =>
      store.models.filter((m) => m.provider === providerId && currentGenSet.has(m.id)),
    currentModel: () => store.currentModel,
    currentModelInfo: () => store.models.find((m) => m.id === store.currentModel),
    setModel: (modelId: ModelId) => {
      setStore(
        produce((draft) => {
          draft.currentModel = modelId
        }),
      )
      props.onModelChange?.(modelId)
    },
    get ready() {
      return store.ready
    },
  }

  return <ModelContext.Provider value={value}>{props.children}</ModelContext.Provider>
}
