import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { extension } from "../api.js"
import type { ProviderContribution } from "../../domain/extension.js"
import { AuthMethod } from "../../domain/auth-method.js"

const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

export const GoogleExtension = extension("@gent/provider-google", ({ ext }) => {
  const googleProvider: ProviderContribution = {
    id: "google",
    name: "Google",
    resolveModel: (modelName, authInfo) => {
      const storedApiKey =
        authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
      const envApiKey = readEnv("GOOGLE_GENERATIVE_AI_API_KEY")
      const apiKey = storedApiKey ?? envApiKey
      const client = createGoogleGenerativeAI(apiKey !== undefined ? { apiKey } : undefined)
      return client(modelName)
    },
    auth: {
      methods: [new AuthMethod({ type: "api", label: "Manually enter API key" })],
    },
  }

  return ext.provider(googleProvider)
})
