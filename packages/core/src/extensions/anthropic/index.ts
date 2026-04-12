import { Clock, Effect, Layer, Redacted } from "effect"
import { extension } from "../api.js"
import type {
  ProviderAuthInfo,
  ProviderContribution,
  ProviderHints,
} from "../../domain/extension.js"
import type { ProviderResolution } from "../../providers/provider.js"
import {
  createAnthropicKeychainFetch,
  initAnthropicKeychainEnv,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
  type AnthropicKeychainEnv,
} from "./oauth.js"
import { AuthMethod } from "../../domain/auth-method.js"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { FetchHttpClient } from "effect/unstable/http"

// Provider extensions read env at setup time (outside Effect runtime, no Config available).
// Lint override in .oxlintrc.json allows process.env in extensions/**/provider dirs.
const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

/** Credential cache — owned by extension closure, not module globals */
interface CredentialCache {
  creds: { accessToken: string; refreshToken: string; expiresAt: number } | null
  at: number
}

const CREDENTIAL_CACHE_TTL_MS = 30_000

type ClaudeCredentials = { accessToken: string; refreshToken: string; expiresAt: number }

const loadCredentialsEffect = (
  cache: CredentialCache,
  authInfo?: ProviderAuthInfo,
): Effect.Effect<ClaudeCredentials | null> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis

    // Check cache
    if (
      cache.creds !== null &&
      now - cache.at < CREDENTIAL_CACHE_TTL_MS &&
      cache.creds.expiresAt > now + 60_000
    ) {
      return cache.creds
    }

    // Read fresh from keychain
    const result = yield* readClaudeCodeCredentials().pipe(
      Effect.catchEager(() => Effect.succeed(null)),
    )
    if (result === null) {
      cache.creds = null
      cache.at = 0
      return null
    }

    if (result.expiresAt <= now + 60_000) {
      // Try refresh
      yield* refreshClaudeCodeCredentials().pipe(Effect.catchEager(() => Effect.void))
      const refreshed = yield* readClaudeCodeCredentials().pipe(
        Effect.catchEager(() => Effect.succeed(null)),
      )
      if (refreshed === null || refreshed.expiresAt <= now + 60_000) {
        cache.creds = null
        cache.at = 0
        return null
      }
      // Persist refreshed creds
      const persist = authInfo?.persist
      if (persist !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            persist({
              access: refreshed.accessToken,
              refresh: refreshed.refreshToken,
              expires: refreshed.expiresAt,
            }),
          catch: (cause) => ({ _tag: "PersistError" as const, cause }),
        }).pipe(
          Effect.catchEager((e) =>
            Effect.logWarning("anthropic.persist.refreshed.credentials.failed").pipe(
              Effect.annotateLogs({ error: String(e.cause) }),
            ),
          ),
        )
      }
      cache.creds = refreshed
      cache.at = now
      return refreshed
    }

    cache.creds = result
    cache.at = now
    return result
  })

const buildCredentialLoader = (cache: CredentialCache, authInfo?: ProviderAuthInfo) => () =>
  Effect.runPromise(loadCredentialsEffect(cache, authInfo))

// Maps gent reasoning level to Anthropic effort (Anthropic caps at "high")
const ANTHROPIC_EFFORT: Record<string, "low" | "medium" | "high"> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
}

const buildAnthropicConfig = (hints?: ProviderHints) => {
  const config: Record<string, unknown> = {}
  if (hints?.maxTokens !== undefined) config["max_tokens"] = hints.maxTokens
  if (hints?.temperature !== undefined) config["temperature"] = hints.temperature
  if (hints?.reasoning !== undefined && hints.reasoning !== "none") {
    const effort = ANTHROPIC_EFFORT[hints.reasoning]
    if (effort !== undefined) {
      config["output_config"] = { effort }
    }
  }
  return config
}

export const AnthropicExtension = extension("@gent/provider-anthropic", ({ ext }) => {
  const env: AnthropicKeychainEnv = {
    betaFlags: readEnv("ANTHROPIC_BETA_FLAGS"),
    cliVersion: readEnv("ANTHROPIC_CLI_VERSION"),
    userAgent: readEnv("ANTHROPIC_USER_AGENT"),
  }
  initAnthropicKeychainEnv(env)

  // Credential cache owned by this extension closure
  const credentialCache: CredentialCache = { creds: null, at: 0 }

  const anthropicProvider: ProviderContribution = {
    id: "anthropic",
    name: "Anthropic",
    resolveModel: (modelName, authInfo, hints): ProviderResolution => {
      // Precedence: stored API key > env API key > keychain/OAuth
      const storedApiKey =
        authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
      const envApiKey = readEnv("ANTHROPIC_API_KEY")
      const apiKey = storedApiKey ?? envApiKey

      const config = buildAnthropicConfig(hints)

      if (apiKey !== undefined) {
        const clientLayer = AnthropicClient.layer({
          apiKey: Redacted.make(apiKey),
        }).pipe(Layer.provide(FetchHttpClient.layer))
        const modelLayer = AnthropicLanguageModel.layer({ model: modelName, config }).pipe(
          Layer.provide(clientLayer),
        )
        return { layer: modelLayer, keychainMode: false }
      }

      // Fall back to keychain/OAuth with extension-owned credential cache
      // Note: keychain mode uses a custom fetch wrapper that handles:
      // - OAuth bearer token auth
      // - mcp_ tool name prefixing (handled at tool/stream level in provider.ts)
      // - System identity injection (handled at prompt level in provider.ts)
      // - Anthropic beta flags, billing headers
      // - Retryable 429/529 with backoff
      // - Long-context beta error retry
      const loadCredentials = buildCredentialLoader(credentialCache, authInfo)
      const keychainFetch = createAnthropicKeychainFetch(loadCredentials)

      // For keychain mode, we still use the custom fetch via FetchHttpClient
      // because the keychain fetch wrapper does complex body/response transforms
      // that are difficult to replicate via HttpClient.transformClient
      const customFetchLayer = Layer.succeed(
        FetchHttpClient.Fetch,
        keychainFetch as typeof globalThis.fetch,
      )
      const clientLayer = AnthropicClient.layer({
        apiKey: Redacted.make("oauth-placeholder"),
      }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(customFetchLayer))
      const modelLayer = AnthropicLanguageModel.layer({ model: modelName, config }).pipe(
        Layer.provide(clientLayer),
      )
      return { layer: modelLayer, keychainMode: true }
    },
    auth: {
      methods: [
        new AuthMethod({ type: "oauth", label: "Claude Code" }),
        new AuthMethod({ type: "api", label: "Manually enter API key" }),
      ],
      authorize: (ctx) =>
        Effect.gen(function* () {
          if (ctx.methodIndex !== 0) return undefined
          let creds = yield* readClaudeCodeCredentials()
          if (creds.expiresAt < (yield* Clock.currentTimeMillis) + 60_000) {
            yield* refreshClaudeCodeCredentials().pipe(Effect.catchEager(() => Effect.void))
            creds = yield* readClaudeCodeCredentials()
          }
          // Persist keychain creds to AuthStore
          yield* ctx.persist({
            type: "oauth",
            access: creds.accessToken,
            refresh: creds.refreshToken,
            expires: creds.expiresAt,
          })
          return {
            url: "" as string,
            method: "done" as const,
          }
        }).pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined)))),
    },
  }

  return ext.provider(anthropicProvider)
})
