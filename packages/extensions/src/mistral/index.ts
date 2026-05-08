import { Effect } from "effect"
import { defineExtension } from "@gent/core/extensions/api"
import { makeApiKeyCompatDriver, readOptionalEnv } from "../openai-compatible-driver.js"

const MISTRAL_COMPAT_URL = "https://api.mistral.ai/v1"

export const MistralExtension = defineExtension({
  id: "@gent/provider-mistral",
  modelDrivers: () =>
    Effect.gen(function* () {
      const envApiKey = yield* readOptionalEnv("MISTRAL_API_KEY")

      return [
        makeApiKeyCompatDriver({
          id: "mistral",
          name: "Mistral",
          envApiKey,
          envVarName: "MISTRAL_API_KEY",
          apiUrl: MISTRAL_COMPAT_URL,
        }),
      ]
    }),
})
