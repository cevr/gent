import { createMistral } from "@ai-sdk/mistral"
import { extension } from "../api.js"
import type { ProviderContribution } from "../../domain/extension.js"
import { AuthMethod } from "../../domain/auth-method.js"

const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

export const MistralExtension = extension("@gent/provider-mistral", (ext) => {
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

  ext.provider(mistralProvider)
})
