import { Effect } from "effect"
import { createAnthropic } from "@ai-sdk/anthropic"
import { defineExtension } from "../../domain/extension.js"
import type { ProviderContribution } from "../../domain/extension.js"
import {
  createAnthropicKeychainFetch,
  getCachedCredentials,
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

      // Credential loader — reads from keychain/file, no AuthStore dependency.
      // AuthStore persistence is handled by ProviderFactory's existing codepath
      // until batch 6 migrates auth into the extension.
      const loadCredentials = () => Effect.runPromise(getCachedCredentials(() => Effect.void))

      const keychainFetch = createAnthropicKeychainFetch(loadCredentials)

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

          // Fall back to keychain/OAuth
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
          authorize: (_, methodIndex) =>
            Effect.gen(function* () {
              if (methodIndex !== 0) return undefined
              let creds = yield* readClaudeCodeCredentials()
              if (creds.expiresAt < Date.now() + 60_000) {
                yield* refreshClaudeCodeCredentials().pipe(Effect.catchEager(() => Effect.void))
                creds = yield* readClaudeCodeCredentials()
              }
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
