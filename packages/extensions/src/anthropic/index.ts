import { BunServices } from "@effect/platform-bun"
import { Clock, Config, Effect, Layer, Option, Redacted, Ref, SynchronizedRef } from "effect"
import {
  AuthMethod,
  defineExtension,
  ExtensionSetupContext,
  ProviderAuthError,
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
import { Model as AiModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { keychainClient } from "./keychain-client.js"
import {
  AnthropicCredentialService,
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCellRef,
} from "./credential-service.js"
import { AnthropicBetaCache, EMPTY_BETA_CELL, type BetaCacheCell } from "./beta-cache.js"
import { buildKeychainTransformClient } from "./keychain-transform.js"
import { AnthropicPlatform, type AnthropicPlatformShape } from "./platform-adapter.js"

const readOptionalEnv = (name: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const opt = yield* Config.option(Config.string(name))
    return Option.getOrUndefined(opt)
  }).pipe(Effect.orElseSucceed(() => undefined))

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
 * are not on the hook for.
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
 * The cache cells for credentials and beta state are passed in from
 * extension-closure scope (allocated once by the Effectful
 * `modelDrivers()` setup), not per layer build. Without this hoist,
 * every `Provider.stream`/`Provider.generate` call rebuilds the service
 * layer and resets the cache, killing cross-request beta learning and
 * credential reuse.
 *
 * No `apiKey` is passed — the SDK's apiKey is optional and skips
 * `x-api-key` injection when absent (verified at
 * `~/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:220`).
 * Avoids a brittle "scrub-the-placeholder" coupling between SDK and
 * middleware ordering.
 */
const makeOauthAnthropicLayer = (
  modelName: string,
  config: Record<string, unknown>,
  authInfo: ProviderAuthInfo | undefined,
  credentialCellRef: CredentialCacheCellRef,
  betaCellRef: Ref.Ref<BetaCacheCell>,
  platform: AnthropicPlatformShape,
) => {
  const credentialLayer = AnthropicCredentialService.layerFromRefAndIO(
    credentialCellRef,
    {
      read: readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
      refresh: refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
    },
    authInfo,
  ).pipe(Layer.provide(Layer.succeed(AnthropicPlatform, platform)))
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
    Layer.provide(BunServices.layer),
  )
}

/**
 * Build the model-driver contribution given pre-allocated cache cell
 * cells. Extracted from the inline `modelDrivers` factory so tests can
 * inject their own cells and assert that two `resolveModel` calls share
 * the same closure-owned cells (fresh Refs per `resolveModel` would
 * kill cross-request beta learning).
 */
export const buildAnthropicModelDriver = (
  credentialCellRef: CredentialCacheCellRef,
  betaCellRef: Ref.Ref<BetaCacheCell>,
  envApiKey: string | undefined,
  platform: AnthropicPlatformShape,
): ModelDriverContribution => ({
  id: "anthropic",
  name: "Anthropic",
  resolveModel: (modelName, authInfo, hints): ProviderResolution => {
    // Precedence: stored API key > env API key > keychain/OAuth
    const storedApiKey =
      authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
    const apiKey = storedApiKey ?? envApiKey

    const config = buildAnthropicConfig(hints)

    if (apiKey !== undefined) {
      return AiModel.make(
        "anthropic",
        modelName,
        makeApiKeyAnthropicLayer(modelName, config, apiKey),
      )
    }

    // Fail closed — no stored API key, no env var, and no stored OAuth.
    // (The OAuth layer builds over `authInfo` — with `authInfo` absent
    // it builds an unauthenticated client that fails late as a generic
    // HTTP error, masking the real auth failure for non-TUI callers.
    // Keychain fallback is handled by the extension's `authorize` flow
    // upstream; by the time we reach `resolveModel`, any valid creds
    // have already been staged into `authInfo`.)
    if (authInfo?.type !== "oauth") {
      throw new ProviderAuthError({
        message:
          "Anthropic credentials unavailable: no Claude Code OAuth, stored API key, or ANTHROPIC_API_KEY env var",
      })
    }

    // OAuth path: per-resolveModel layer build wires the
    // extension-closure-owned cache cells into a fresh credential
    // service + beta cache layer pair. The Refs are shared across all
    // calls, so cross-request beta learning and credential cache reuse
    // survive.
    return AiModel.make(
      "anthropic",
      modelName,
      makeOauthAnthropicLayer(
        modelName,
        config,
        authInfo,
        credentialCellRef,
        betaCellRef,
        platform,
      ),
    )
  },
  auth: {
    methods: [
      AuthMethod.make({ type: "oauth", label: "Claude Code" }),
      AuthMethod.make({ type: "api", label: "Manually enter API key" }),
    ],
    authorize: (ctx) =>
      Effect.gen(function* () {
        if (ctx.methodIndex !== 0) return undefined
        // The Claude Code authorize flow targets the primary
        // account by default. PRIMARY_CLAUDE_SERVICE is spelled
        // out here so a future audit-grep finds every "default"
        // site (the multi-account picker UI is the next consumer).
        let creds = yield* readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
        const now = yield* Clock.currentTimeMillis
        if (!freshEnoughForUse(creds, now)) {
          // Use the returned creds — re-reading keychain after refresh
          // would silently lose direct-OAuth tokens whenever write-back
          // failed.
          creds = yield* refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
        }
        // Persist keychain creds to Auth
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
      }).pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(
            new ProviderAuthError({
              message: `Anthropic authorization failed: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
          ),
        ),
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(Layer.merge(BunServices.layer, Layer.succeed(AnthropicPlatform, platform))),
      ),
  },
})

export const AnthropicExtension = defineExtension({
  id: "@gent/provider-anthropic",
  modelDrivers: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionSetupContext
      const env: AnthropicKeychainEnv = {
        betaFlags: yield* readOptionalEnv("ANTHROPIC_BETA_FLAGS"),
        cliVersion: yield* readOptionalEnv("ANTHROPIC_CLI_VERSION"),
        entrypoint: yield* readOptionalEnv("CLAUDE_CODE_ENTRYPOINT"),
        userAgent: yield* readOptionalEnv("ANTHROPIC_USER_AGENT"),
      }
      initAnthropicKeychainEnv(env)

      const envApiKey = yield* readOptionalEnv("ANTHROPIC_API_KEY")
      const platform = AnthropicPlatform.fromSetup({
        platform: ctx.host.osInfo.platform,
        home: ctx.home,
        Process: ctx.Process,
      })

      // Cache cells are hoisted to extension-closure scope so they
      // survive across `resolveModel` calls. Lifetime: one extension
      // instance → one cell that lives until the runtime tears the
      // extension down. Setup is Effectful, so cache cells are allocated
      // through SynchronizedRef.make instead of an unsafe closure escape hatch.
      const credentialCellRef = yield* SynchronizedRef.make(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)

      return [buildAnthropicModelDriver(credentialCellRef, betaCellRef, envApiKey, platform)]
    }),
})
