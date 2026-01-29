import { Context, Effect, Layer, Schema } from "effect"
import type { LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { fromIni } from "@aws-sdk/credential-providers"
import {
  AuthStorage,
  type AuthStorageService,
  type CustomProviderConfig,
  type ProviderApi,
  type Model,
  type ModelId,
  DEFAULT_MODELS,
  SUPPORTED_PROVIDERS,
} from "@gent/core"
import { ProviderError } from "./provider"

// Provider info for listing
export class ProviderInfo extends Schema.Class<ProviderInfo>("ProviderInfo")({
  id: Schema.String,
  name: Schema.String,
  isCustom: Schema.Boolean,
}) {}

// Service interface
export interface ProviderFactoryService {
  /** Get a language model by full model ID (provider/model-name) */
  readonly getModel: (modelId: string) => Effect.Effect<LanguageModel, ProviderError>
  /** List all available providers (built-in + custom) */
  readonly listProviders: () => Effect.Effect<readonly ProviderInfo[]>
  /** List all available models (built-in + custom) */
  readonly listModels: () => Effect.Effect<readonly Model[]>
}

// Service tag
export class ProviderFactory extends Context.Tag(
  "@gent/providers/src/provider-factory/ProviderFactory",
)<ProviderFactory, ProviderFactoryService>() {
  static Live: Layer.Layer<ProviderFactory, never, AuthStorage | CustomProvidersConfig> =
    Layer.effect(
      ProviderFactory,
      Effect.gen(function* () {
        const authStorage = yield* AuthStorage
        const customProvidersConfig = yield* CustomProvidersConfig

        return makeProviderFactory(authStorage, customProvidersConfig.providers)
      }),
    )

  static Test = (
    customProviders?: Readonly<Record<string, CustomProviderConfig>>,
  ): Layer.Layer<ProviderFactory> =>
    Layer.succeed(ProviderFactory, makeProviderFactory(testAuthStorage, customProviders))
}

// Config context for custom providers
export class CustomProvidersConfig extends Context.Tag(
  "@gent/providers/src/provider-factory/CustomProvidersConfig",
)<
  CustomProvidersConfig,
  { providers: Readonly<Record<string, CustomProviderConfig>> | undefined }
>() {
  static fromConfig = (
    providers: Readonly<Record<string, CustomProviderConfig>> | undefined,
  ): Layer.Layer<CustomProvidersConfig> => Layer.succeed(CustomProvidersConfig, { providers })
}

// Test auth storage (no-op)
const testAuthStorage: AuthStorageService = {
  get: () => Effect.succeed(undefined),
  set: () => Effect.void,
  delete: () => Effect.void,
  list: () => Effect.succeed([]),
}

// Env var names for built-in providers
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY",
}

// Resolve API key: env var (custom or default) → AuthStorage
const resolveApiKey = (
  providerName: string,
  auth: AuthStorageService,
  customEnvVar?: string,
): Effect.Effect<string | undefined> => {
  // Check custom env var first
  if (customEnvVar !== undefined && customEnvVar !== "") {
    const envKey = process.env[customEnvVar]
    if (envKey !== undefined && envKey !== "") return Effect.succeed(envKey)
  }

  // Check default env var
  const defaultEnvVar = PROVIDER_ENV_VARS[providerName]
  if (defaultEnvVar !== undefined && defaultEnvVar !== "") {
    const envKey = process.env[defaultEnvVar]
    if (envKey !== undefined && envKey !== "") return Effect.succeed(envKey)
  }

  // Fall back to AuthStorage
  return auth.get(providerName).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
}

type ProviderClient = (modelName: string) => LanguageModel

// Create AI SDK provider client
const createProviderClient = (
  api: ProviderApi,
  apiKey: string | undefined,
  baseUrl: string | undefined,
): ProviderClient | undefined => {
  const resolvedApiKey = apiKey !== undefined && apiKey !== "" ? { apiKey } : undefined
  switch (api) {
    case "anthropic":
      return createAnthropic(resolvedApiKey)
    case "openai":
      return createOpenAI(resolvedApiKey)
    case "openai-compatible":
      if (baseUrl === undefined || baseUrl === "") return undefined
      return createOpenAI({
        baseURL: baseUrl,
        ...(resolvedApiKey ?? {}),
      })
    case "azure-openai":
      // Azure OpenAI uses different config, requires resource name etc.
      // For now, treat as openai-compatible with baseUrl
      if (baseUrl === undefined || baseUrl === "") return undefined
      return createOpenAI({
        baseURL: baseUrl,
        ...(resolvedApiKey ?? {}),
      })
    case "bedrock":
      return createAmazonBedrock({
        region: process.env["AWS_REGION"] ?? "us-east-1",
        credentialProvider: async () => {
          const creds = await fromIni()()
          return {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            ...(creds.sessionToken !== undefined ? { sessionToken: creds.sessionToken } : {}),
          }
        },
      })
    case "google":
      return createGoogleGenerativeAI(resolvedApiKey)
    case "mistral":
      return createMistral(resolvedApiKey)
  }
}

// Parse model ID into provider and model name
const parseModelId = (modelId: string): [string, string] => {
  const slash = modelId.indexOf("/")
  if (slash === -1) {
    return ["anthropic", modelId]
  }
  return [modelId.slice(0, slash), modelId.slice(slash + 1)]
}

// Get built-in API type for provider
const getBuiltinApi = (providerId: string): ProviderApi | undefined => {
  switch (providerId) {
    case "anthropic":
      return "anthropic"
    case "openai":
      return "openai"
    case "bedrock":
      return "bedrock"
    case "google":
      return "google"
    case "mistral":
      return "mistral"
    default:
      return undefined
  }
}

// Factory implementation
const makeProviderFactory = (
  auth: AuthStorageService,
  customProviders: Readonly<Record<string, CustomProviderConfig>> | undefined,
): ProviderFactoryService => ({
  getModel: Effect.fn("ProviderFactory.getModel")(function* (modelId: string) {
    const [providerName, modelName] = parseModelId(modelId)

    // Check if custom provider
    const customConfig = customProviders?.[providerName]

    if (customConfig !== undefined) {
      const apiKey = yield* resolveApiKey(providerName, auth, customConfig.apiKeyEnv)
      const client = createProviderClient(customConfig.api, apiKey, customConfig.baseUrl)
      if (client === undefined) {
        const message =
          customConfig.api === "azure-openai"
            ? "Azure OpenAI provider requires baseUrl"
            : "OpenAI-compatible provider requires baseUrl"
        return yield* new ProviderError({
          message,
          model: modelId,
        })
      }
      return client(modelName)
    }

    // Built-in provider
    const api = getBuiltinApi(providerName)
    if (api === undefined) {
      return yield* new ProviderError({
        message: `Unknown provider: ${providerName}`,
        model: modelId,
      })
    }

    const apiKey = yield* resolveApiKey(providerName, auth)
    const client = createProviderClient(api, apiKey, undefined)
    if (client === undefined) {
      return yield* new ProviderError({
        message: `Provider requires baseUrl: ${api}`,
        model: modelId,
      })
    }
    return client(modelName)
  }),

  listProviders: () =>
    Effect.succeed([
      // Built-in providers
      ...SUPPORTED_PROVIDERS.map(
        (p) =>
          new ProviderInfo({
            id: p.id,
            name: p.name,
            isCustom: false,
          }),
      ),
      // Custom providers
      ...Object.entries(customProviders ?? {}).map(
        ([id, _config]) =>
          new ProviderInfo({
            id,
            name: id, // Use ID as name for custom providers
            isCustom: true,
          }),
      ),
    ]),

  listModels: () =>
    Effect.succeed([
      // Built-in models
      ...DEFAULT_MODELS,
      // Custom models from custom providers
      ...Object.entries(customProviders ?? {}).flatMap(([providerId, config]) =>
        (config.models ?? []).map(
          (m) =>
            ({
              id: `${providerId}/${m.id}` as ModelId,
              name: m.name,
              provider: providerId,
              contextLength: m.contextLength,
              pricing: undefined,
            }) as Model,
        ),
      ),
    ]),
})
