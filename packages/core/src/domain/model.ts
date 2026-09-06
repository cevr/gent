import { Option, Schema } from "effect"
import { branded } from "./ids.js"

// Model ID - provider/model format

export const ModelId = Schema.String.pipe(branded("ModelId"))
export type ModelId = typeof ModelId.Type

// Provider - AI provider identifier (open, branded string — extensible via extensions)

export const ProviderId = Schema.String.pipe(branded("ProviderId"))
export type ProviderId = typeof ProviderId.Type

// Model pricing per million tokens (USD)

export const ModelPricing = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
})
export type ModelPricing = typeof ModelPricing.Type

// Model - individual model from a provider (built-in or custom)

export class Model extends Schema.Class<Model>("Model")({
  id: ModelId,
  name: Schema.String,
  provider: ProviderId,
  contextLength: Schema.optional(Schema.Finite),
  pricing: Schema.optional(ModelPricing),
}) {}

// Calculate cost from token usage

export const calculateCost = (
  usage: { inputTokens: number; outputTokens: number },
  pricing: Option.Option<ModelPricing>,
): number => {
  if (Option.isNone(pricing)) return 0
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.value.input
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.value.output
  return inputCost + outputCost
}

export const BUILTIN_PROVIDER_IDS = new Set<string>(["anthropic", "openai", "google", "mistral"])

export const parseModelProvider = (modelId: string): Option.Option<ProviderId> => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return Option.none()
  return Option.some(ProviderId.make(modelId.slice(0, slash)))
}

export const parseModelId = (modelId: string): Option.Option<readonly [ProviderId, string]> => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return Option.none()
  return Option.some([ProviderId.make(modelId.slice(0, slash)), modelId.slice(slash + 1)])
}
