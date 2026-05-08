import { Effect } from "effect"
import { defineExtension } from "@gent/core/extensions/api"
import { makeApiKeyCompatDriver, readOptionalEnv } from "../openai-compatible-driver.js"

const GOOGLE_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai"

export const GoogleExtension = defineExtension({
  id: "@gent/provider-google",
  modelDrivers: () =>
    Effect.gen(function* () {
      const envApiKey = yield* readOptionalEnv("GOOGLE_GENERATIVE_AI_API_KEY")

      return [
        makeApiKeyCompatDriver({
          id: "google",
          name: "Google",
          envApiKey,
          envVarName: "GOOGLE_GENERATIVE_AI_API_KEY",
          apiUrl: GOOGLE_COMPAT_URL,
        }),
      ]
    }),
})
