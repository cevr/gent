import { Effect } from "effect"
import { createMistral } from "@ai-sdk/mistral"
import { defineExtension } from "../../domain/extension.js"
import type { ProviderContribution } from "../../domain/extension.js"
import { AuthMethod } from "../../domain/auth-method.js"

const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

export const MistralExtension = defineExtension({
  manifest: { id: "@gent/provider-mistral" },
  setup: () =>
    Effect.sync(() => {
      const mistralProvider: ProviderContribution = {
        id: "mistral",
        name: "Mistral",
        resolveModel: (modelName, authInfo) => {
          const storedApiKey =
            authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
          const envApiKey = readEnv("MISTRAL_API_KEY")
          const apiKey = storedApiKey ?? envApiKey
          const client = createMistral(apiKey !== undefined ? { apiKey } : undefined)
          return client(modelName)
        },
        auth: {
          methods: [new AuthMethod({ type: "api", label: "Manually enter API key" })],
        },
      }

      return { providers: [mistralProvider] }
    }),
})
