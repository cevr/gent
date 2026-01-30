import { Schema } from "effect"
import { PermissionRule } from "./permission"
import { AgentName } from "./agent"

// Model Configuration

export class ModelConfig extends Schema.Class<ModelConfig>("ModelConfig")({
  default: Schema.String,
  deep: Schema.optional(Schema.String),
}) {}

// Custom Provider Configuration

/** Custom model definition for user-defined providers */
export class CustomModel extends Schema.Class<CustomModel>("CustomModel")({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.optional(Schema.Number),
}) {}

/** Supported provider API types */
export const ProviderApi = Schema.Literal(
  "anthropic",
  "openai",
  "openai-compatible",
  "azure-openai",
  "bedrock",
  "google",
  "mistral",
)
export type ProviderApi = typeof ProviderApi.Type

/** Custom provider configuration */
export class CustomProviderConfig extends Schema.Class<CustomProviderConfig>(
  "CustomProviderConfig",
)({
  /** API type - determines which SDK/client to use */
  api: ProviderApi,
  /** Base URL for OpenAI-compatible APIs */
  baseUrl: Schema.optional(Schema.String),
  /** Environment variable name for API key */
  apiKeyEnv: Schema.optional(Schema.String),
  /** Custom models available from this provider */
  models: Schema.optional(Schema.Array(CustomModel)),
}) {}

// Gent Configuration

export class GentConfig extends Schema.Class<GentConfig>("GentConfig")({
  models: ModelConfig,
  permissions: Schema.optional(Schema.Array(PermissionRule)),
  defaultAgent: Schema.optional(AgentName),
  subprocessBinaryPath: Schema.optional(Schema.String),
}) {}

// Default Configuration

export const defaultConfig: GentConfig = new GentConfig({
  models: new ModelConfig({
    default: "openai/opus-4.5",
    deep: "openai/codex-5.2",
  }),
  permissions: [],
})
