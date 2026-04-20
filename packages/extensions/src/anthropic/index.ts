import { Clock, Effect, Layer, Redacted } from "effect"
import {
  defineExtension,
  AuthMethod,
  type ModelDriverContribution,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import {
  createAnthropicKeychainFetch,
  freshEnoughForUse,
  initAnthropicKeychainEnv,
  PRIMARY_CLAUDE_SERVICE,
  readClaudeCodeCredentials,
  refreshClaudeCodeCredentials,
  type AnthropicKeychainEnv,
} from "./oauth.js"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { FetchHttpClient } from "effect/unstable/http"
import { keychainClient } from "./keychain-client.js"
import { buildAnthropicCredentialLoader, type CredentialCache } from "./runtime-boundary.js"

// Provider extensions read env at setup time (outside Effect runtime, no Config available).
// Lint override in .oxlintrc.json allows process.env in extensions/**/provider dirs.
const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

// Credential loader + cache live in `runtime-boundary.ts` — that module
// owns the Promise edge into the Anthropic SDK loader contract.

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
  modelDrivers: () => {
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
        const credentialLoader = buildAnthropicCredentialLoader(credentialCache, authInfo)
        const keychainFetch = createAnthropicKeychainFetch(credentialLoader)

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
            // The Claude Code authorize flow targets the primary
            // account by default. PRIMARY_CLAUDE_SERVICE is spelled
            // out here so a future audit-grep finds every "default"
            // site (counsel K2 — multi-account picker UI is the
            // next consumer).
            let creds = yield* readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
            const now = yield* Clock.currentTimeMillis
            if (!freshEnoughForUse(creds, now)) {
              // Use the returned creds — the previous shape re-read
              // keychain after refresh and silently lost direct-OAuth
              // tokens whenever write-back failed (counsel HIGH #1).
              creds = yield* refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
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

    return [anthropicProvider]
  },
})
