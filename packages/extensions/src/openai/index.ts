import { Duration, Effect, Fiber, Layer, SynchronizedRef } from "effect"
import {
  defineExtension,
  AuthMethod,
  Model,
  ProviderAuthError,
  type ModelDriverContribution,
  type ProviderAuthInfo,
  type ProviderAuthorizationResult,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import {
  allocateOpenAIAuthorization,
  OPENAI_OAUTH_ALLOWED_MODELS,
  type OpenAIAuthorizationFlow,
} from "./oauth.js"
import {
  OpenAiClient as OpenAiResponsesClient,
  OpenAiLanguageModel as OpenAiResponsesLanguageModel,
} from "@effect/ai-openai"
import { Model as AiModel } from "effect/unstable/ai"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  OpenAICredentialService,
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCellRef,
} from "./credential-service.js"
import { buildCodexTransformClient } from "./codex-transform.js"
import {
  buildOpenAiCompatConfig,
  makeOpenAiCompatResolution,
  readOptionalEnv,
} from "../openai-compatible-driver.js"

type PendingCallbackEntry = {
  readonly flow: OpenAIAuthorizationFlow
  readonly close: Effect.Effect<void>
  readonly timeoutFiber: Fiber.Fiber<void>
}

const buildOpenAiResponsesConfig = (hints?: ProviderHints) => {
  const config: Record<string, unknown> = { store: false }
  if (hints?.maxTokens !== undefined) config["max_output_tokens"] = hints.maxTokens
  if (hints?.temperature !== undefined) config["temperature"] = hints.temperature
  if (hints?.reasoning !== undefined && hints.reasoning !== "none") {
    config["reasoning"] = {
      effort: hints.reasoning,
      summary: "auto",
    }
  }
  return config
}

// ── Layer construction helpers ──

/**
 * API-key path: plain OpenAI-compatible client over `FetchHttpClient`. No
 * Codex transform — the Codex backend rewrite + OAuth headers are
 * specific to the ChatGPT OAuth path.
 */
const makeApiKeyOpenAIResolution = (
  modelName: string,
  config: Record<string, unknown>,
  apiKey: string,
) => makeOpenAiCompatResolution({ provider: "openai", modelName, apiKey, config })

/**
 * OAuth path: builds `OpenAiClient.layer` with `transformClient` set to
 * the Codex transform middleware (auth headers, URL/body/beta rewrite,
 * 401 recovery). No `apiKey` — the SDK only injects Bearer auth when
 * `apiKey !== undefined`, so omitting it lets our middleware own the
 * Authorization header without a "scrub-the-placeholder" coupling.
 *
 * The credential cache cell is passed in from extension-closure
 * scope (allocated once by the Effectful `modelDrivers()` setup), not
 * allocated per layer build. Without this hoist, every
 * `Provider.stream`/`Provider.generate` call would rebuild the service
 * layer and reset the cache, killing credential reuse and the rotated
 * refresh-token contract.
 */
const makeOauthOpenAILayer = (
  modelName: string,
  config: Record<string, unknown>,
  authInfo: ProviderAuthInfo,
  credentialCellRef: CredentialCacheCellRef,
) => {
  const credentialLayer = OpenAICredentialService.layerFromRef(credentialCellRef, authInfo)

  const clientLayer = Layer.unwrap(
    Effect.gen(function* () {
      const creds = yield* OpenAICredentialService
      const codexHttpClientLayer = Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          return buildCodexTransformClient(creds)(client)
        }),
      ).pipe(Layer.provide(FetchHttpClient.layer))
      return OpenAiResponsesClient.layer({
        apiUrl: "https://chatgpt.com/backend-api/codex",
      }).pipe(Layer.provide(codexHttpClientLayer))
    }),
  ).pipe(Layer.provide(credentialLayer))

  return OpenAiResponsesLanguageModel.layer({ model: modelName, config }).pipe(
    Layer.provide(clientLayer),
  )
}

/**
 * Build the model-driver contribution given a pre-allocated credential
 * cache cell. Extracted from the inline `modelDrivers` factory so
 * tests can inject their own cell and assert that two `resolveModel`
 * calls share the same closure-owned cell.
 */
export const buildOpenAIModelDriver = (
  credentialCellRef: CredentialCacheCellRef,
  pendingCallbacks: Map<string, PendingCallbackEntry>,
  envApiKey: string | undefined,
): ModelDriverContribution => ({
  id: "openai",
  name: "OpenAI",
  resolveModel: (modelName, authInfo, hints): ProviderResolution => {
    // Stored OAuth — handle inline with token refresh. The ChatGPT Codex
    // backend speaks the Responses shape, so the OAuth path uses
    // @effect/ai-openai instead of the chat-completions compat adapter.
    if (authInfo?.type === "oauth") {
      const config = buildOpenAiResponsesConfig(hints)
      if (!OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)) {
        throw new ProviderAuthError({
          message: `Model "${modelName}" not available with ChatGPT OAuth`,
        })
      }
      return AiModel.make(
        "openai",
        modelName,
        makeOauthOpenAILayer(modelName, config, authInfo, credentialCellRef),
      )
    }

    // Stored API key takes precedence over env var
    const storedApiKey =
      authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
    const apiKey = storedApiKey ?? envApiKey

    if (apiKey !== undefined) {
      return makeApiKeyOpenAIResolution(
        modelName,
        buildOpenAiCompatConfig(hints, { includeReasoning: true }),
        apiKey,
      )
    }

    // Fail closed — no stored OAuth, no stored API key, no env var.
    // Previous versions fell through to `OpenAiClient.layer({})` and let
    // the unauthenticated request fail late as a generic HTTP error,
    // masking the real auth failure for non-TUI callers.
    throw new ProviderAuthError({
      message:
        "OpenAI credentials unavailable: no ChatGPT OAuth, stored API key, or OPENAI_API_KEY env var",
    })
  },
  listModels: (baseCatalog, authInfo) => {
    // When OAuth is active, filter to allowed models + zero pricing
    if (authInfo?.type !== "oauth") return baseCatalog
    return baseCatalog
      .filter((model) => {
        if (model.provider !== "openai") return true
        const parts = model.id.split("/", 2)
        const modelName = parts[1]
        return modelName !== undefined && OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)
      })
      .map((model) => {
        if (model.provider !== "openai") return model
        return Model.make({ ...model, pricing: { input: 0, output: 0 } })
      })
  },
  auth: {
    methods: [
      AuthMethod.make({ type: "oauth", label: "ChatGPT Pro/Plus" }),
      AuthMethod.make({ type: "api", label: "Manually enter API key" }),
    ],
    authorize: (ctx): Effect.Effect<ProviderAuthorizationResult | undefined, ProviderAuthError> =>
      Effect.gen(function* () {
        if (ctx.methodIndex !== 0) return undefined
        const { flow, close } = yield* allocateOpenAIAuthorization.pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `OpenAI OAuth authorization failed: ${e.message}`,
                cause: e,
              }),
          ),
        )
        // 5-minute TTL on abandoned auth attempts. Without this an
        // abandoned flow leaves the redirect HTTP server resident
        // until extension teardown. The fiber both clears the map
        // entry and closes the OAuth scope (tears down the listener).
        const timeoutFiber = yield* Effect.sleep(Duration.minutes(5)).pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              pendingCallbacks.delete(ctx.authorizationId)
              yield* close
            }),
          ),
          Effect.forkChild,
        )
        pendingCallbacks.set(ctx.authorizationId, { flow, close, timeoutFiber })
        return flow.authorization
      }),
    callback: (ctx) =>
      Effect.gen(function* () {
        const entry = pendingCallbacks.get(ctx.authorizationId)
        pendingCallbacks.delete(ctx.authorizationId)
        if (entry === undefined) {
          return yield* new ProviderAuthError({
            message: "OpenAI OAuth callback state is missing or expired",
          })
        }
        yield* Fiber.interrupt(entry.timeoutFiber)
        const result = yield* entry.flow.callback(ctx.code).pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `OpenAI OAuth callback failed: ${e.message}`,
                cause: e,
              }),
          ),
          Effect.ensuring(entry.close),
        )
        yield* ctx.persist({
          type: "oauth",
          access: result.access,
          refresh: result.refresh,
          expires: result.expires,
          ...(result.accountId !== undefined ? { accountId: result.accountId } : {}),
        })
      }),
  },
})

export const OpenAIExtension = defineExtension({
  id: "@gent/provider-openai",
  modelDrivers: () =>
    Effect.gen(function* () {
      // Credential cache cell hoisted to extension-closure scope so it
      // survives across `resolveModel` calls. One extension instance →
      // one cell that lives until the runtime tears the extension down.
      // Setup is Effectful, so the cache cell is allocated through
      // SynchronizedRef.make instead of an unsafe closure escape hatch.
      const credentialCellRef = yield* SynchronizedRef.make(EMPTY_CREDENTIAL_CELL)
      // Pending OAuth callbacks keyed by authorizationId. Entries
      // self-clear on a 5-min TTL so abandoned auth attempts don't leak.
      const pendingCallbacks = new Map<string, PendingCallbackEntry>()

      const envApiKey = yield* readOptionalEnv("OPENAI_API_KEY")

      return [buildOpenAIModelDriver(credentialCellRef, pendingCallbacks, envApiKey)]
    }),
})
