import { Clock, Effect, Layer, Redacted, Ref } from "effect"
import {
  defineExtension,
  AuthMethod,
  type ModelDriverContribution,
  type ProviderAuthInfo,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import {
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
import {
  AnthropicCredentialService,
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCell,
} from "./credential-service.js"
import { AnthropicBetaCache, EMPTY_BETA_CELL, type BetaCacheCell } from "./beta-cache.js"
import { buildKeychainTransformClient } from "./keychain-transform.js"

// Provider extensions read env at setup time (outside Effect runtime, no Config available).
// Lint override in .oxlintrc.json allows process.env in extensions/**/provider dirs.
const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

// Credential cache + refresh logic live in `AnthropicCredentialService`
// (Effect-native). The OAuth path provides this service into the layer
// that hosts `AnthropicClient`; the keychain transform middleware reads
// from it per-request via `mapRequestEffect`.

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

// ── Layer construction helpers ──

/**
 * API-key path: plain `AnthropicClient.layer` over `FetchHttpClient`.
 * No keychain wrapper — `keychainClient` injects Claude Code OAuth
 * billing-header system blocks + identity prefix, which API-key users
 * are not on the hook for. Pre-C3 code did not wrap this branch either;
 * counsel C3 HIGH #2 caught the regression.
 */
const makeApiKeyAnthropicLayer = (
  modelName: string,
  config: Record<string, unknown>,
  apiKey: string,
) => {
  const clientLayer = AnthropicClient.layer({
    apiKey: Redacted.make(apiKey),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return AnthropicLanguageModel.layer({ model: modelName, config }).pipe(Layer.provide(clientLayer))
}

/**
 * OAuth path: builds `AnthropicClient.layer` with `transformClient` set
 * to the keychain transform middleware (auth headers, 429/529 retry,
 * transport retry, long-context beta retry, 401 recovery). Uses
 * `Layer.unwrap` because the transform factory needs the credential
 * service and beta cache instances at construction time, and those
 * come from layers that the unwrapped Effect can `yield*`.
 *
 * Counsel C3 HIGH #1: the cache cell `Ref`s for both services are
 * passed in from extension-closure scope (built once in `modelDrivers()`
 * via `Ref.makeUnsafe`), not allocated per layer build. Without this
 * hoist, every `Provider.stream`/`Provider.generate` call rebuilt the
 * service layer and reset the cache, killing cross-request beta
 * learning and credential reuse. Legacy code achieved the same with
 * `credentialCache: CredentialCache = { creds: null, at: 0 }` in
 * extension-closure scope plus module-globals for beta exclusions.
 *
 * Counsel C3 MEDIUM: no `apiKey` is passed — the SDK's apiKey is
 * optional and skips `x-api-key` injection when absent (verified at
 * `~/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:220`).
 * Avoids a brittle "scrub-the-placeholder" coupling between SDK and
 * middleware ordering.
 */
const makeOauthAnthropicLayer = (
  modelName: string,
  config: Record<string, unknown>,
  authInfo: ProviderAuthInfo | undefined,
  credentialCellRef: Ref.Ref<CredentialCacheCell>,
  betaCellRef: Ref.Ref<BetaCacheCell>,
) => {
  const credentialLayer = AnthropicCredentialService.layerFromRef(credentialCellRef, authInfo)
  const cacheLayer = AnthropicBetaCache.layerFromRef(betaCellRef)

  const clientLayer = Layer.unwrap(
    Effect.gen(function* () {
      const creds = yield* AnthropicCredentialService
      const cache = yield* AnthropicBetaCache
      return AnthropicClient.layer({
        transformClient: buildKeychainTransformClient(creds, cache),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  ).pipe(Layer.provide(credentialLayer), Layer.provide(cacheLayer))

  const wrappedClient = keychainClient.pipe(Layer.provide(clientLayer))
  return AnthropicLanguageModel.layer({ model: modelName, config }).pipe(
    Layer.provide(wrappedClient),
  )
}

/**
 * Build the model-driver contribution given pre-allocated cache cell
 * Refs. Extracted from the inline `modelDrivers` factory so tests can
 * inject their own Refs and assert that two `resolveModel` calls share
 * the same closure-owned cells (the C3 regression that counsel caught:
 * fresh Refs per `resolveModel` killed cross-request beta learning).
 */
export const buildAnthropicModelDriver = (
  credentialCellRef: Ref.Ref<CredentialCacheCell>,
  betaCellRef: Ref.Ref<BetaCacheCell>,
): ModelDriverContribution => ({
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
      return { layer: makeApiKeyAnthropicLayer(modelName, config, apiKey) }
    }

    // OAuth path: per-resolveModel layer build wires the
    // extension-closure-owned cache cells into a fresh credential
    // service + beta cache layer pair. The Refs are shared across all
    // calls, so cross-request beta learning and credential cache reuse
    // survive — matching the legacy closure-cache + module-globals
    // semantics. Counsel C3 HIGH #1.
    return {
      layer: makeOauthAnthropicLayer(modelName, config, authInfo, credentialCellRef, betaCellRef),
    }
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
})

export const AnthropicExtension = defineExtension({
  id: "@gent/provider-anthropic",
  modelDrivers: () => {
    const env: AnthropicKeychainEnv = {
      betaFlags: readEnv("ANTHROPIC_BETA_FLAGS"),
      cliVersion: readEnv("ANTHROPIC_CLI_VERSION"),
      userAgent: readEnv("ANTHROPIC_USER_AGENT"),
    }
    initAnthropicKeychainEnv(env)

    // Counsel C3 HIGH #1: cache cells are hoisted to extension-closure
    // scope so they survive across `resolveModel` calls. Lifetime
    // matches the legacy module-state-with-clear-on-change behavior:
    // one extension instance → one cell that lives until the runtime
    // tears the extension down. `Ref.makeUnsafe` is the right primitive
    // here because `modelDrivers()` is sync (no Effect runtime).
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = Ref.makeUnsafe<BetaCacheCell>(EMPTY_BETA_CELL)

    return [buildAnthropicModelDriver(credentialCellRef, betaCellRef)]
  },
})
