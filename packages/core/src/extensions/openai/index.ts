import { Effect, Layer, Redacted } from "effect"
import { extension } from "../api.js"
import type {
  ProviderAuthInfo,
  ProviderContribution,
  ProviderHints,
} from "../../domain/extension.js"
import type { ProviderResolution } from "../../providers/provider.js"
import {
  authorizeOpenAI,
  createOpenAIOAuthFetch,
  refreshOpenAIOauth,
  OPENAI_OAUTH_ALLOWED_MODELS,
} from "./oauth.js"
import { AuthOauth } from "../../domain/auth-store.js"
import { AuthMethod } from "../../domain/auth-method.js"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { FetchHttpClient } from "effect/unstable/http"

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

type OAuthCallback = (code?: string) => Promise<{
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
}>

const buildOpenAiConfig = (hints?: ProviderHints) => {
  const config: Record<string, unknown> = {}
  if (hints?.maxTokens !== undefined) config["max_tokens"] = hints.maxTokens
  if (hints?.temperature !== undefined) config["temperature"] = hints.temperature
  if (hints?.reasoning !== undefined && hints.reasoning !== "none") {
    config["reasoning_effort"] = hints.reasoning
  }
  return config
}

export const OpenAIExtension = extension("@gent/provider-openai", ({ ext }) => {
  // Pending OAuth callbacks keyed by authorizationId (closure state)
  const pendingCallbacks = new Map<string, OAuthCallback>()
  const openaiProvider: ProviderContribution = {
    id: "openai",
    name: "OpenAI",
    resolveModel: (modelName, authInfo, hints): ProviderResolution => {
      const config = buildOpenAiConfig(hints)

      // Stored OAuth — handle inline with token refresh
      // Uses openai-compat (Chat Completions) since the Codex endpoint expects that format
      if (authInfo?.type === "oauth") {
        if (!OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)) {
          throw new Error(`Model "${modelName}" not available with ChatGPT OAuth`)
        }
        const loadAuth = buildOAuthLoader(authInfo)
        const oauthFetch = createOpenAIOAuthFetch(loadAuth)

        // Provide custom fetch via FetchHttpClient.Fetch layer
        const customFetchLayer = Layer.succeed(
          FetchHttpClient.Fetch,
          oauthFetch as typeof globalThis.fetch,
        )
        const clientLayer = OpenAiClient.layer({
          apiKey: Redacted.make("oauth"),
        }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(customFetchLayer))
        const modelLayer = OpenAiLanguageModel.layer({ model: modelName, config }).pipe(
          Layer.provide(clientLayer),
        )
        return { layer: modelLayer }
      }

      // Stored API key takes precedence over env var
      const storedApiKey =
        authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
      const envApiKey = readEnv("OPENAI_API_KEY")
      const apiKey = storedApiKey ?? envApiKey

      if (apiKey !== undefined) {
        const clientLayer = OpenAiClient.layer({
          apiKey: Redacted.make(apiKey),
        }).pipe(Layer.provide(FetchHttpClient.layer))
        const modelLayer = OpenAiLanguageModel.layer({ model: modelName, config }).pipe(
          Layer.provide(clientLayer),
        )
        return { layer: modelLayer }
      }

      // No auth available — try unauthenticated (will fail at API call time)
      const clientLayer = OpenAiClient.layer({}).pipe(Layer.provide(FetchHttpClient.layer))
      const modelLayer = OpenAiLanguageModel.layer({ model: modelName, config }).pipe(
        Layer.provide(clientLayer),
      )
      return { layer: modelLayer }
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
      authorize: (ctx) =>
        Effect.tryPromise({
          try: async () => {
            if (ctx.methodIndex !== 0) return undefined
            const { authorization, callback: cb } = await authorizeOpenAI()
            pendingCallbacks.set(ctx.authorizationId, cb)
            return authorization
          },
          catch: (e) => ({
            _tag: "OpenAIOAuthError" as const,
            cause: e,
          }),
        }).pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined)))),
      callback: (ctx) =>
        Effect.gen(function* () {
          const cb = pendingCallbacks.get(ctx.authorizationId)
          pendingCallbacks.delete(ctx.authorizationId)
          if (cb === undefined) return
          const result = yield* Effect.tryPromise({
            try: () => cb(ctx.code),
            catch: (e) => ({
              _tag: "OpenAIOAuthCallbackError" as const,
              cause: e,
            }),
          })
          yield* ctx.persist({
            type: "oauth",
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
            ...(result.accountId !== undefined ? { accountId: result.accountId } : {}),
          })
        }).pipe(Effect.catchEager(() => Effect.void)),
    },
  }

  return ext.provider(openaiProvider)
})
