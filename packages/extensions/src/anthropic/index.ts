import { Clock, Effect, Layer, Redacted } from "effect"
import {
  defineExtension,
  modelDriverContribution,
  AuthMethod,
  type ModelDriverContribution,
  type ProviderAuthInfo,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import {
  createAnthropicKeychainFetch,
  initAnthropicKeychainEnv,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
  type AnthropicKeychainEnv,
} from "./oauth.js"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { FetchHttpClient } from "effect/unstable/http"
import { keychainClient } from "./keychain-client.js"

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
        yield* persist({
          access: refreshed.accessToken,
          refresh: refreshed.refreshToken,
          expires: refreshed.expiresAt,
        }).pipe(
          Effect.catchDefect((cause) =>
            Effect.logWarning("anthropic.persist.refreshed.credentials.failed").pipe(
              Effect.annotateLogs({ error: String(cause) }),
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

export const AnthropicExtension = defineExtension({
  id: "@gent/provider-anthropic",
  contributions: () => {
    const env: AnthropicKeychainEnv = {
      betaFlags: readEnv("ANTHROPIC_BETA_FLAGS"),
      cliVersion: readEnv("ANTHROPIC_CLI_VERSION"),
      userAgent: readEnv("ANTHROPIC_USER_AGENT"),
    }
    initAnthropicKeychainEnv(env)

    // Credential cache owned by this extension closure
    const credentialCache: CredentialCache = { creds: null, at: 0 }

    const anthropicProvider: ModelDriverContribution = {
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
          return { layer: modelLayer }
        }

        // Fall back to keychain/OAuth with extension-owned credential cache.
        // keychainClient wraps AnthropicClient to handle mcp_ tool prefixing,
        // system identity injection, and cache control at the structured payload level.
        // The custom fetch handles: auth headers, beta flags, billing, 429/529 retry.
        const loadCredentials = buildCredentialLoader(credentialCache, authInfo)
        const keychainFetch = createAnthropicKeychainFetch(loadCredentials)

        const customFetchLayer = Layer.succeed(
          FetchHttpClient.Fetch,
          keychainFetch as typeof globalThis.fetch,
        )
        const baseClientLayer = AnthropicClient.layer({
          apiKey: Redacted.make("oauth-placeholder"),
        }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(customFetchLayer))
        // Wrap the base client with keychain transforms (mcp_, identity, cache control)
        const wrappedClientLayer = keychainClient.pipe(Layer.provide(baseClientLayer))
        const modelLayer = AnthropicLanguageModel.layer({ model: modelName, config }).pipe(
          Layer.provide(wrappedClientLayer),
        )
        return { layer: modelLayer }
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

    return [modelDriverContribution(anthropicProvider)]
  },
})
