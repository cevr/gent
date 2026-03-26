import { Effect } from "effect"
import { createOpenAI } from "@ai-sdk/openai"
import { defineExtension } from "../../domain/extension.js"
import type { ProviderAuthInfo, ProviderContribution } from "../../domain/extension.js"
import {
  createOpenAIOAuthFetch,
  refreshOpenAIOauth,
  OPENAI_OAUTH_ALLOWED_MODELS,
} from "../../providers/oauth/openai-oauth.js"
import { AuthOauth } from "../../domain/auth-store.js"
import { AuthMethod } from "../../domain/auth-method.js"

const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

/** Build an OAuth fetch wrapper from ProviderAuthInfo tokens + persist callback */
const buildOAuthLoader = (authInfo: ProviderAuthInfo) => {
  // Mutable token state for the lifetime of this model resolution
  let current = {
    access: authInfo.access ?? "",
    refresh: authInfo.refresh ?? "",
    expires: authInfo.expires ?? 0,
    accountId: authInfo.accountId,
  }

  return async (): Promise<AuthOauth> => {
    if (current.access.length > 0 && current.expires >= Date.now()) {
      return new AuthOauth({
        type: "oauth",
        access: current.access,
        refresh: current.refresh,
        expires: current.expires,
        ...(current.accountId !== undefined ? { accountId: current.accountId } : {}),
      })
    }

    // Token expired — refresh
    const refreshed = await refreshOpenAIOauth(current.refresh)
    current = {
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId ?? current.accountId,
    }

    // Persist back to AuthStore
    if (authInfo.persist !== undefined) {
      await authInfo.persist(current).catch((e) => {
        console.warn("[openai] failed to persist refreshed OAuth tokens:", e)
      })
    }

    return new AuthOauth({
      type: "oauth",
      access: current.access,
      refresh: current.refresh,
      expires: current.expires,
      ...(current.accountId !== undefined ? { accountId: current.accountId } : {}),
    })
  }
}

export const OpenAIExtension = defineExtension({
  manifest: { id: "@gent/provider-openai" },
  setup: () =>
    Effect.sync(() => {
      const openaiProvider: ProviderContribution = {
        id: "openai",
        name: "OpenAI",
        resolveModel: (modelName, authInfo) => {
          // Stored OAuth — handle inline with token refresh
          if (authInfo?.type === "oauth") {
            if (!OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)) {
              throw new Error(`Model "${modelName}" not available with ChatGPT OAuth`)
            }
            const loadAuth = buildOAuthLoader(authInfo)
            const oauthFetch = createOpenAIOAuthFetch(loadAuth)
            const client = createOpenAI({
              apiKey: "oauth",
              fetch: oauthFetch,
              headers: { originator: "gent" },
            })
            return client.responses(modelName)
          }

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
        listModels: (baseCatalog, authInfo) => {
          // When OAuth is active, filter to allowed models + zero pricing
          if (authInfo?.type !== "oauth") return baseCatalog
          return baseCatalog
            .filter((model) => {
              const m = model as { provider?: string; id?: string }
              if (m.provider !== "openai") return true
              const parts = String(m.id ?? "").split("/", 2)
              const modelName = parts[1]
              return modelName !== undefined && OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)
            })
            .map((model) => {
              const m = model as { provider?: string; pricing?: unknown }
              if (m.provider !== "openai") return model
              return { ...m, pricing: { input: 0, output: 0 } }
            })
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
