import { Effect } from "effect"
import { createOpenAI } from "@ai-sdk/openai"
import { defineExtension } from "../../domain/extension.js"
import type { ProviderContribution } from "../../domain/extension.js"
import { AuthMethod } from "../../domain/auth-method.js"

const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

export const OpenAIExtension = defineExtension({
  manifest: { id: "@gent/provider-openai" },
  setup: () =>
    Effect.sync(() => {
      const openaiProvider: ProviderContribution = {
        id: "openai",
        name: "OpenAI",
        resolveModel: (modelName, authInfo) => {
          // Stored OAuth is the user's explicit auth choice — fall through to
          // builtin dispatch which handles token refresh via AuthStore.
          if (authInfo?.type === "oauth") return undefined

          // Stored API key takes precedence over env var
          const storedApiKey =
            authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
          const envApiKey = readEnv("OPENAI_API_KEY")
          const apiKey = storedApiKey ?? envApiKey

          if (apiKey !== undefined) {
            return createOpenAI({ apiKey })(modelName)
          }

          // No auth available — try unauthenticated (will fail at API call time)
          return createOpenAI({})(modelName)
        },
        auth: {
          methods: [
            new AuthMethod({ type: "oauth", label: "ChatGPT Pro/Plus" }),
            new AuthMethod({ type: "api", label: "Manually enter API key" }),
          ],
        },
      }

      return { providers: [openaiProvider] }
    }),
})
