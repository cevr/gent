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

export const readOptionalEnv = (name: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const opt = yield* Config.option(Config.string(name))
    return Option.getOrUndefined(opt)
  }).pipe(Effect.orElseSucceed(() => undefined))

export const buildOpenAiCompatConfig = (
  hints?: ProviderHints,
  options?: { readonly includeReasoning?: boolean },
): Record<string, unknown> => {
  const config: Record<string, unknown> = {}
  if (hints?.maxTokens !== undefined) config["max_tokens"] = hints.maxTokens
  if (hints?.temperature !== undefined) config["temperature"] = hints.temperature
  if (
    options?.includeReasoning === true &&
    hints?.reasoning !== undefined &&
    hints.reasoning !== "none"
  ) {
    config["reasoning_effort"] = hints.reasoning
  }
  return config
}

export const makeOpenAiCompatResolution = (params: {
  readonly provider: string
  readonly modelName: string
  readonly apiKey: string
  readonly config: Record<string, unknown>
  readonly apiUrl?: string
}): ProviderResolution => {
  const clientLayer = OpenAiClient.layer({
    apiKey: Redacted.make(params.apiKey),
    ...(params.apiUrl !== undefined ? { apiUrl: params.apiUrl } : {}),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  const modelLayer = OpenAiLanguageModel.layer({
    model: params.modelName,
    config: params.config,
  }).pipe(Layer.provide(clientLayer))
  return AiModel.make(params.provider, params.modelName, modelLayer)
}

export const makeApiKeyCompatDriver = (params: {
  readonly id: string
  readonly name: string
  readonly envApiKey: string | undefined
  readonly envVarName: string
  readonly apiUrl?: string
}): ModelDriverContribution => ({
  id: params.id,
  name: params.name,
  resolveModel: (modelName, authInfo, hints): ProviderResolution => {
    const storedApiKey =
      authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
    const apiKey = storedApiKey ?? params.envApiKey
    if (apiKey === undefined) {
      throw new ProviderAuthError({
        message: `${params.name} credentials unavailable: no stored API key or ${params.envVarName} env var`,
      })
    }
    return makeOpenAiCompatResolution({
      provider: params.id,
      modelName,
      apiKey,
      apiUrl: params.apiUrl,
      config: buildOpenAiCompatConfig(hints),
    })
  },
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
            apiUrl: params.apiUrl,
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
