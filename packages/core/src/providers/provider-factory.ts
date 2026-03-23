import { ServiceMap, Config, Effect, Layer, Option, Schema } from "effect"
import type { LanguageModel } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { fromIni } from "@aws-sdk/credential-providers"
import { AuthStore, type AuthInfo } from "../domain/auth-store.js"
import { SUPPORTED_PROVIDERS } from "../domain/model.js"
import { ProviderError } from "./provider"
import {
  OPENAI_OAUTH_ALLOWED_MODELS,
  createOpenAIOAuthFetch,
  loadOpenAIOAuth,
} from "./oauth/openai-oauth"
import {
  createAnthropicKeychainFetch,
  getCachedCredentials,
  initAnthropicKeychainEnv,
} from "./oauth/anthropic-keychain"

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
const testAuthStorage = {
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
      return yield* makeProviderFactory()
    }),
  )

  static Test: Layer.Layer<ProviderFactory> = Layer.provide(
    Layer.effect(ProviderFactory, makeProviderFactory()),
    Layer.succeed(AuthStore, testAuthStorage),
  )
}

type ProviderClient = (modelName: string) => LanguageModel
type AnthropicCredentialLoader = Parameters<typeof createAnthropicKeychainFetch>[0]
type OpenAioAuthLoader = Parameters<typeof createOpenAIOAuthFetch>[0]

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
  loadCredentials: AnthropicCredentialLoader,
  auth: AuthInfo | undefined,
  apiKey: { apiKey: string } | undefined,
) => {
  if (auth?.type === "oauth") {
    return createAnthropic({
      apiKey: "oauth-placeholder",
      fetch: createAnthropicKeychainFetch(loadCredentials),
    })
  }
  return createAnthropic(apiKey)
}

const createOpenAIClient = (
  loadOauth: OpenAioAuthLoader,
  auth: AuthInfo | undefined,
  apiKey: { apiKey: string } | undefined,
) => {
  if (auth?.type === "oauth") {
    const oauthClient = createOpenAI({
      apiKey: "oauth",
      fetch: createOpenAIOAuthFetch(loadOauth),
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
  loadCredentials: AnthropicCredentialLoader,
  loadOauth: OpenAioAuthLoader,
  auth: AuthInfo | undefined,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  region: string | undefined,
): ProviderClient | undefined => {
  const resolvedApiKey = apiKey !== undefined && apiKey !== "" ? { apiKey } : undefined
  switch (api) {
    case "anthropic":
      return createAnthropicClient(loadCredentials, auth, resolvedApiKey)
    case "openai":
      return createOpenAIClient(loadOauth, auth, resolvedApiKey)
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
function makeProviderFactory(): Effect.Effect<ProviderFactoryService, never, AuthStore> {
  return Effect.gen(function* () {
    const authStore = yield* AuthStore
    const resolveAuthFromStore = (providerName: string) =>
      authStore
        .get(providerName)
        .pipe(Effect.catchEager(() => Effect.sync(() => undefined as AuthInfo | undefined)))

    const loadAnthropicCredentials: AnthropicCredentialLoader = () =>
      Effect.runPromise(
        getCachedCredentials((auth) =>
          authStore.set("anthropic", auth).pipe(Effect.catchEager(() => Effect.void)),
        ),
      )

    const loadOpenAiOauth: OpenAioAuthLoader = () =>
      loadOpenAIOAuth({
        getCurrent: async () => {
          const auth = await Effect.runPromise(
            authStore.get("openai").pipe(Effect.catchEager(() => Effect.void)),
          )
          return auth?.type === "oauth" ? auth : undefined
        },
        setCurrent: (auth) => Effect.runPromise(authStore.set("openai", auth)),
      })

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

        const authInfo = yield* resolveAuthFromStore(providerName)
        const apiKey = authInfo?.type === "api" ? authInfo.key : undefined

        if (authInfo?.type === "oauth" && providerName === "openai") {
          if (!OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)) {
            return yield* new ProviderError({
              message: "Model not available with ChatGPT OAuth",
              model: modelId,
            })
          }
        }
        const region =
          api === "bedrock" ? ((yield* readEnv("AWS_REGION")) ?? "us-east-1") : undefined
        const client = createProviderClient(
          api,
          loadAnthropicCredentials,
          loadOpenAiOauth,
          authInfo,
          apiKey,
          undefined,
          region,
        )
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
            (provider) =>
              new ProviderInfo({ id: provider.id, name: provider.name, isCustom: false }),
          ),
        ),
    }
  })
}
