import { Effect } from "effect"
import { createAnthropic } from "@ai-sdk/anthropic"
import { defineExtension } from "../../domain/extension.js"
import type { ProviderAuthInfo, ProviderContribution } from "../../domain/extension.js"
import {
  createAnthropicKeychainFetch,
  initAnthropicKeychainEnv,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
  type AnthropicKeychainEnv,
} from "../../providers/oauth/anthropic-keychain.js"
import { AuthMethod } from "../../domain/auth-method.js"

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
    const now = Date.now()

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
            Effect.logWarning("[anthropic] failed to persist refreshed credentials", e.cause),
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

export const AnthropicExtension = defineExtension({
  manifest: { id: "@gent/provider-anthropic" },
  setup: () =>
    Effect.sync(() => {
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
        resolveModel: (modelName, authInfo) => {
          // Precedence: stored API key > env API key > keychain/OAuth
          const storedApiKey =
            authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
          const envApiKey = readEnv("ANTHROPIC_API_KEY")
          const apiKey = storedApiKey ?? envApiKey

          if (apiKey !== undefined) {
            return createAnthropic({ apiKey })(modelName)
          }

          // Fall back to keychain/OAuth with extension-owned credential cache
          const loadCredentials = buildCredentialLoader(credentialCache, authInfo)
          const keychainFetch = createAnthropicKeychainFetch(loadCredentials)
          return createAnthropic({
            apiKey: "oauth-placeholder",
            fetch: keychainFetch,
          })(modelName)
        },
        auth: {
          methods: [
            new AuthMethod({ type: "oauth", label: "Claude Code" }),
            new AuthMethod({ type: "api", label: "Manually enter API key" }),
          ],
          authorize: (_, methodIndex, persist) =>
            Effect.gen(function* () {
              if (methodIndex !== 0) return undefined
              let creds = yield* readClaudeCodeCredentials()
              if (creds.expiresAt < Date.now() + 60_000) {
                yield* refreshClaudeCodeCredentials().pipe(Effect.catchEager(() => Effect.void))
                creds = yield* readClaudeCodeCredentials()
              }
              // Persist keychain creds to AuthStore
              yield* persist({
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

      return { providers: [anthropicProvider] }
    }),
})
