import { Schema } from "effect"

// Model ID - provider/model format

export const ModelId = Schema.String.pipe(Schema.brand("ModelId"))
export type ModelId = typeof ModelId.Type

// Provider - supported AI provider

export const ProviderId = Schema.Literal("anthropic", "bedrock", "openai", "google", "mistral")
export type ProviderId = typeof ProviderId.Type

export class Provider extends Schema.Class<Provider>("Provider")({
  id: ProviderId,
  name: Schema.String,
}) {}

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

// Supported providers with display names

export const SUPPORTED_PROVIDERS: readonly Provider[] = [
  new Provider({ id: "anthropic", name: "Anthropic" }),
  new Provider({ id: "bedrock", name: "AWS Bedrock" }),
  new Provider({ id: "openai", name: "OpenAI" }),
  new Provider({ id: "google", name: "Google" }),
  new Provider({ id: "mistral", name: "Mistral" }),
]

const PROVIDER_ID_SET = new Set<ProviderId>(["anthropic", "bedrock", "openai", "google", "mistral"])

export const parseModelProvider = (modelId: string): ProviderId | undefined => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return undefined
  const provider = modelId.slice(0, slash) as ProviderId
  return PROVIDER_ID_SET.has(provider) ? provider : undefined
}
