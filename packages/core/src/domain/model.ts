import { Schema } from "effect"

// Model ID - provider/model format

export const ModelId = Schema.String.pipe(Schema.brand("ModelId"))
export type ModelId = typeof ModelId.Type

// Provider - AI provider identifier (open, branded string — extensible via extensions)

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"))
export type ProviderId = typeof ProviderId.Type

// Model pricing per million tokens (USD)

export const ModelPricing = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
})
export type ModelPricing = typeof ModelPricing.Type

// Model - individual model from a provider (built-in or custom)

export class Model extends Schema.Class<Model>("Model")({
  id: ModelId,
  name: Schema.String,
  provider: Schema.String,
  contextLength: Schema.optional(Schema.Number),
  pricing: Schema.optional(ModelPricing),
}) {}

// Calculate cost from token usage

export const calculateCost = (
  usage: { inputTokens: number; outputTokens: number },
  pricing: ModelPricing | undefined,
): number => {
  if (pricing === undefined) return 0
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output
  return inputCost + outputCost
}

const BUILTIN_PROVIDER_IDS = new Set<string>([
  "anthropic",
  "bedrock",
  "openai",
  "google",
  "mistral",
])

export const parseModelProvider = (modelId: string): ProviderId | undefined => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return undefined
  const prefix = modelId.slice(0, slash)
  return BUILTIN_PROVIDER_IDS.has(prefix) ? (prefix as ProviderId) : undefined
}
