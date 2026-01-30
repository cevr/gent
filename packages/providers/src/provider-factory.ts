import { Context, Effect, Layer, Schema } from "effect"
import type { LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { fromIni } from "@aws-sdk/credential-providers"
import { AuthStorage, type AuthStorageService, SUPPORTED_PROVIDERS } from "@gent/core"
import { ProviderError } from "./provider"

type ProviderApi =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "azure-openai"
  | "bedrock"
  | "google"
  | "mistral"

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
  /** List all available providers (built-in only) */
  readonly listProviders: () => Effect.Effect<readonly ProviderInfo[]>
}

// Test auth storage (no-op)
const testAuthStorage: AuthStorageService = {
  get: () => Effect.succeed(undefined),
  set: () => Effect.void,
  delete: () => Effect.void,
  list: () => Effect.succeed([]),
}

// Service tag
export class ProviderFactory extends Context.Tag(
  "@gent/providers/src/provider-factory/ProviderFactory",
)<ProviderFactory, ProviderFactoryService>() {
  static Live: Layer.Layer<ProviderFactory, never, AuthStorage> = Layer.effect(
    ProviderFactory,
    Effect.gen(function* () {
      const authStorage = yield* AuthStorage
      return makeProviderFactory(authStorage)
    }),
  )

  static Test: Layer.Layer<ProviderFactory> = Layer.succeed(
    ProviderFactory,
    makeProviderFactory(testAuthStorage),
  )
}

// Env var names for built-in providers
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY",
}

// Resolve API key: env var → AuthStorage
const resolveApiKey = (
  providerName: string,
  auth: AuthStorageService,
): Effect.Effect<string | undefined> => {
  const defaultEnvVar = PROVIDER_ENV_VARS[providerName]
  if (defaultEnvVar !== undefined && defaultEnvVar !== "") {
    const envKey = process.env[defaultEnvVar]
    if (envKey !== undefined && envKey !== "") return Effect.succeed(envKey)
  }

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
const parseModelId = (modelId: string): [string, string] | undefined => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return undefined
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
function makeProviderFactory(auth: AuthStorageService): ProviderFactoryService {
  return {
    getModel: Effect.fn("ProviderFactory.getModel")(function* (modelId: string) {
      const parsed = parseModelId(modelId)
      if (parsed === undefined) {
        return yield* new ProviderError({
          message: "Invalid model id (expected provider/model)",
          model: modelId,
        })
      }
      const [providerName, modelName] = parsed

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
          message: "Provider client unavailable",
          model: modelId,
        })
      }

      return client(modelName)
    }),

    listProviders: () =>
      Effect.succeed(
        SUPPORTED_PROVIDERS.map(
          (provider) => new ProviderInfo({ id: provider.id, name: provider.name, isCustom: false }),
        ),
      ),
  }
}
