import { ServiceMap, Config, Effect, Layer, Option, Schema } from "effect"
import type { LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { fromIni } from "@aws-sdk/credential-providers"
import { AuthStore, type AuthInfo, type AuthStoreService } from "../domain/auth-store.js"
import { SUPPORTED_PROVIDERS } from "../domain/model.js"
import { ProviderError } from "./provider"
import { OPENAI_OAUTH_ALLOWED_MODELS, createOpenAIOAuthFetch } from "./oauth/openai-oauth"
import { createAnthropicKeychainFetch, initAnthropicKeychainEnv } from "./oauth/anthropic-keychain"

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
const testAuthStorage: AuthStoreService = {
  get: () => Effect.sync(() => undefined as AuthInfo | undefined),
  set: () => Effect.void,
  remove: () => Effect.void,
  list: () => Effect.succeed([]),
  listInfo: () => Effect.succeed({}),
}

const readEnv = (name: string) =>
  Effect.gen(function* () {
    const opt = yield* Config.option(Config.string(name))
    return Option.getOrUndefined(opt)
  }).pipe(Effect.catchEager(() => Effect.sync(() => undefined as string | undefined)))

// Service tag
export class ProviderFactory extends ServiceMap.Service<ProviderFactory, ProviderFactoryService>()(
  "@gent/core/src/providers/provider-factory/ProviderFactory",
) {
  static Live: Layer.Layer<ProviderFactory, never, AuthStore> = Layer.effect(
    ProviderFactory,
    Effect.gen(function* () {
      // Read Anthropic env vars via Config at layer construction
      const betaFlags = yield* readEnv("ANTHROPIC_BETA_FLAGS")
      const cliVersion = yield* readEnv("ANTHROPIC_CLI_VERSION")
      const userAgent = yield* readEnv("ANTHROPIC_USER_AGENT")
      initAnthropicKeychainEnv({ betaFlags, cliVersion, userAgent })

      const authStore = yield* AuthStore
      return makeProviderFactory(authStore)
    }),
  )

  static Test: Layer.Layer<ProviderFactory> = Layer.succeed(
    ProviderFactory,
    makeProviderFactory(testAuthStorage),
  )
}

// Resolve auth: AuthStore only (curated, no env override)
const resolveAuth = (
  providerName: string,
  auth: AuthStoreService,
): Effect.Effect<AuthInfo | undefined> =>
  auth
    .get(providerName)
    .pipe(Effect.catchEager(() => Effect.sync(() => undefined as AuthInfo | undefined)))

type ProviderClient = (modelName: string) => LanguageModel

const createOpenAICompatibleClient = (
  baseUrl: string | undefined,
  apiKey: { apiKey: string } | undefined,
) => {
  if (baseUrl === undefined || baseUrl === "") return undefined
  return createOpenAI({
    baseURL: baseUrl,
    ...(apiKey ?? {}),
  })
}

const createBedrockClient = (region: string | undefined) =>
  createAmazonBedrock({
    region: region ?? "us-east-1",
    credentialProvider: async () => {
      const creds = await fromIni()()
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken !== undefined ? { sessionToken: creds.sessionToken } : {}),
      }
    },
  })

const createAnthropicClient = (
  authStore: AuthStoreService,
  auth: AuthInfo | undefined,
  apiKey: { apiKey: string } | undefined,
) => {
  if (auth?.type === "oauth") {
    return createAnthropic({
      apiKey: "oauth-placeholder",
      fetch: createAnthropicKeychainFetch(authStore),
    })
  }
  return createAnthropic(apiKey)
}

const createOpenAIClient = (
  authStore: AuthStoreService,
  auth: AuthInfo | undefined,
  apiKey: { apiKey: string } | undefined,
) => {
  if (auth?.type === "oauth") {
    const oauthClient = createOpenAI({
      apiKey: "oauth",
      fetch: createOpenAIOAuthFetch(authStore),
      headers: {
        originator: "gent",
      },
    })
    return (modelName: string) => oauthClient.responses(modelName)
  }
  return createOpenAI(apiKey)
}

// Create AI SDK provider client
const createProviderClient = (
  api: ProviderApi,
  authStore: AuthStoreService,
  auth: AuthInfo | undefined,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  region: string | undefined,
): ProviderClient | undefined => {
  const resolvedApiKey = apiKey !== undefined && apiKey !== "" ? { apiKey } : undefined
  switch (api) {
    case "anthropic":
      return createAnthropicClient(authStore, auth, resolvedApiKey)
    case "openai":
      return createOpenAIClient(authStore, auth, resolvedApiKey)
    case "openai-compatible":
      return createOpenAICompatibleClient(baseUrl, resolvedApiKey)
    case "azure-openai":
      return createOpenAICompatibleClient(baseUrl, resolvedApiKey)
    case "bedrock":
      return createBedrockClient(region)
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
function makeProviderFactory(auth: AuthStoreService): ProviderFactoryService {
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

      const authInfo = yield* resolveAuth(providerName, auth)
      const apiKey = authInfo?.type === "api" ? authInfo.key : undefined

      if (authInfo?.type === "oauth" && providerName === "openai") {
        if (!OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)) {
          return yield* new ProviderError({
            message: "Model not available with ChatGPT OAuth",
            model: modelId,
          })
        }
      }
      const region = api === "bedrock" ? ((yield* readEnv("AWS_REGION")) ?? "us-east-1") : undefined
      const client = createProviderClient(api, auth, authInfo, apiKey, undefined, region)
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
