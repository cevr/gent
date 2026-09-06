import { Config, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Model as AiModel } from "effect/unstable/ai"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import {
  AuthMethod,
  ProviderAuthError,
  defineExtension,
  type ModelDriverContribution,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"

const GOOGLE_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai"
const MISTRAL_COMPAT_URL = "https://api.mistral.ai/v1"

type OpenAiCompatConfig = Required<Parameters<typeof OpenAiLanguageModel.layer>[0]>["config"]

export const readOptionalEnv = (name: string): Effect.Effect<Option.Option<string>> =>
  Config.option(Config.string(name)).pipe(Effect.orElseSucceed(() => Option.none()))

export const buildOpenAiCompatConfig = (
  hints: Option.Option<ProviderHints>,
  includeReasoning: boolean,
): OpenAiCompatConfig => {
  let config: OpenAiCompatConfig = {}
  if (Option.isSome(hints)) {
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
    const reasoning = Option.fromNullishOr(hints.value.reasoning)
    if (includeReasoning && Option.isSome(reasoning) && reasoning.value !== "none") {
      config = { ...config, reasoning_effort: reasoning.value }
    }
  }
  return config
}

export const makeOpenAiCompatResolution = (params: {
  readonly provider: string
  readonly modelName: string
  readonly apiKey: string
  readonly config: OpenAiCompatConfig
  readonly apiUrl: Option.Option<string>
}): ProviderResolution => {
  let clientLayer = OpenAiClient.layer({ apiKey: Redacted.make(params.apiKey) })
  if (Option.isSome(params.apiUrl)) {
    clientLayer = OpenAiClient.layer({
      apiKey: Redacted.make(params.apiKey),
      apiUrl: params.apiUrl.value,
    })
  }
  const providedClientLayer = clientLayer.pipe(Layer.provide(FetchHttpClient.layer))
  const modelLayer = OpenAiLanguageModel.layer({
    model: params.modelName,
    config: params.config,
  }).pipe(Layer.provide(providedClientLayer))
  return AiModel.make(params.provider, params.modelName, modelLayer)
}

export const makeApiKeyCompatDriver = (params: {
  readonly id: string
  readonly name: string
  readonly envApiKey: Option.Option<string>
  readonly envVarName: string
  readonly apiUrl: Option.Option<string>
}): ModelDriverContribution => ({
  id: params.id,
  name: params.name,
  resolveModel: (modelName, authInfo, hints) =>
    Effect.gen(function* () {
      let apiKey = params.envApiKey
      if (authInfo?.type === "api") apiKey = Option.fromNullishOr(authInfo.key)
      if (Option.isNone(apiKey)) {
        return yield* new ProviderAuthError({
          message: `${params.name} credentials unavailable: no stored API key or ${params.envVarName} env var`,
        })
      }
      return makeOpenAiCompatResolution({
        provider: params.id,
        modelName,
        apiKey: apiKey.value,
        apiUrl: params.apiUrl,
        config: buildOpenAiCompatConfig(Option.fromNullishOr(hints), false),
      })
    }),
  auth: {
    methods: [AuthMethod.make({ type: "api", label: "Manually enter API key" })],
  },
})

const makeApiKeyCompatExtension = (params: {
  readonly extensionId: string
  readonly driverId: string
  readonly name: string
  readonly envVarName: string
  readonly apiUrl: string
}) =>
  defineExtension({
    id: params.extensionId,
    modelDrivers: () =>
      Effect.gen(function* () {
        const envApiKey = yield* readOptionalEnv(params.envVarName)
        return [
          makeApiKeyCompatDriver({
            id: params.driverId,
            name: params.name,
            envApiKey,
            envVarName: params.envVarName,
            apiUrl: Option.some(params.apiUrl),
          }),
        ]
      }),
  })

export const GoogleExtension = makeApiKeyCompatExtension({
  extensionId: "@gent/provider-google",
  driverId: "google",
  name: "Google",
  envVarName: "GOOGLE_GENERATIVE_AI_API_KEY",
  apiUrl: GOOGLE_COMPAT_URL,
})

export const MistralExtension = makeApiKeyCompatExtension({
  extensionId: "@gent/provider-mistral",
  driverId: "mistral",
  name: "Mistral",
  envVarName: "MISTRAL_API_KEY",
  apiUrl: MISTRAL_COMPAT_URL,
})
