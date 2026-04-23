import { Layer, Redacted } from "effect"
import {
  defineExtension,
  AuthMethod,
  type ModelDriverContribution,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { FetchHttpClient } from "effect/unstable/http"

const MISTRAL_COMPAT_URL = "https://api.mistral.ai/v1"

const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

const buildConfig = (hints?: ProviderHints) => {
  const config: Record<string, unknown> = {}
  if (hints?.maxTokens !== undefined) config["max_tokens"] = hints.maxTokens
  if (hints?.temperature !== undefined) config["temperature"] = hints.temperature
  return config
}

export const MistralExtension = defineExtension({
  id: "@gent/provider-mistral",
  modelDrivers: () => {
    const mistralProvider: ModelDriverContribution = {
      id: "mistral",
      name: "Mistral",
      resolveModel: (modelName, authInfo, hints): ProviderResolution => {
        const storedApiKey =
          authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
        const envApiKey = readEnv("MISTRAL_API_KEY")
        const apiKey = storedApiKey ?? envApiKey
        const config = buildConfig(hints)

        const clientLayer = OpenAiClient.layer({
          ...(apiKey !== undefined ? { apiKey: Redacted.make(apiKey) } : {}),
          apiUrl: MISTRAL_COMPAT_URL,
        }).pipe(Layer.provide(FetchHttpClient.layer))
        const modelLayer = OpenAiLanguageModel.layer({ model: modelName, config }).pipe(
          Layer.provide(clientLayer),
        )
        return { layer: modelLayer }
      },
      auth: {
        methods: [AuthMethod.make({ type: "api", label: "Manually enter API key" })],
      },
    }

    return [mistralProvider]
  },
})
