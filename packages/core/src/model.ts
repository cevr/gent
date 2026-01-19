import { Schema } from "effect"

// Model ID - provider/model format

export const ModelId = Schema.String.pipe(Schema.brand("ModelId"))
export type ModelId = typeof ModelId.Type

// Provider - supported AI provider

export const ProviderId = Schema.Literal(
  "anthropic",
  "bedrock",
  "openai",
  "google",
  "mistral"
)
export type ProviderId = typeof ProviderId.Type

export class Provider extends Schema.Class<Provider>("Provider")({
  id: ProviderId,
  name: Schema.String,
}) {}

// Model - individual model from a provider

export class Model extends Schema.Class<Model>("Model")({
  id: ModelId,
  name: Schema.String,
  provider: ProviderId,
  contextLength: Schema.optional(Schema.Number),
}) {}

// Supported providers with display names

export const SUPPORTED_PROVIDERS: readonly Provider[] = [
  new Provider({ id: "anthropic", name: "Anthropic" }),
  new Provider({ id: "bedrock", name: "AWS Bedrock" }),
  new Provider({ id: "openai", name: "OpenAI" }),
  new Provider({ id: "google", name: "Google" }),
  new Provider({ id: "mistral", name: "Mistral" }),
]

// Default/fallback models when API unavailable

export const DEFAULT_MODELS: readonly Model[] = [
  // Anthropic
  new Model({
    id: "anthropic/claude-sonnet-4-20250514" as ModelId,
    name: "Claude Sonnet 4",
    provider: "anthropic",
    contextLength: 200000,
  }),
  new Model({
    id: "anthropic/claude-opus-4-20250514" as ModelId,
    name: "Claude Opus 4",
    provider: "anthropic",
    contextLength: 200000,
  }),
  new Model({
    id: "anthropic/claude-3-5-haiku-20241022" as ModelId,
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
    contextLength: 200000,
  }),
  // Bedrock
  new Model({
    id: "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0" as ModelId,
    name: "Claude Sonnet 4",
    provider: "bedrock",
    contextLength: 200000,
  }),
  new Model({
    id: "bedrock/us.anthropic.claude-opus-4-20250514-v1:0" as ModelId,
    name: "Claude Opus 4",
    provider: "bedrock",
    contextLength: 200000,
  }),
  new Model({
    id: "bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0" as ModelId,
    name: "Claude 3.5 Haiku",
    provider: "bedrock",
    contextLength: 200000,
  }),
  // OpenAI
  new Model({
    id: "openai/gpt-4o" as ModelId,
    name: "GPT-4o",
    provider: "openai",
    contextLength: 128000,
  }),
  new Model({
    id: "openai/gpt-4o-mini" as ModelId,
    name: "GPT-4o Mini",
    provider: "openai",
    contextLength: 128000,
  }),
  new Model({
    id: "openai/o1" as ModelId,
    name: "o1",
    provider: "openai",
    contextLength: 200000,
  }),
  new Model({
    id: "openai/o3-mini" as ModelId,
    name: "o3 Mini",
    provider: "openai",
    contextLength: 200000,
  }),
  // Google
  new Model({
    id: "google/gemini-2.0-flash" as ModelId,
    name: "Gemini 2.0 Flash",
    provider: "google",
    contextLength: 1000000,
  }),
  new Model({
    id: "google/gemini-2.0-pro" as ModelId,
    name: "Gemini 2.0 Pro",
    provider: "google",
    contextLength: 2000000,
  }),
  // Mistral
  new Model({
    id: "mistral/mistral-large-latest" as ModelId,
    name: "Mistral Large",
    provider: "mistral",
    contextLength: 128000,
  }),
  new Model({
    id: "mistral/codestral-latest" as ModelId,
    name: "Codestral",
    provider: "mistral",
    contextLength: 256000,
  }),
]

// Default model ID for the application
export const DEFAULT_MODEL_ID = "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0" as ModelId
