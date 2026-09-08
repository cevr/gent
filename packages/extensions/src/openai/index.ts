import { Duration, Effect, Fiber, Layer, Option, Schema, SynchronizedRef } from "effect"
import {
  defineExtension,
  ExtensionHost,
  AuthMethod,
  Model,
  ProviderAuthError,
  type ModelDriverContribution,
  type ProviderAuthInfo,
  type ProviderAuthorizationResult,
  type ProviderHints,
} from "@gent/core/extensions/api"
import {
  allocateOpenAIAuthorization,
  allocateOpenAIDeviceAuthorization,
  isOpenAIOAuthModel,
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

/** Index-aligned with the `oauth` entries of `auth.methods` below. */
const OAUTH_ALLOCATORS: ReadonlyArray<typeof allocateOpenAIAuthorization> = [
  allocateOpenAIAuthorization,
  allocateOpenAIDeviceAuthorization,
]

type OpenAiResponsesConfig = Required<
  Parameters<typeof OpenAiResponsesLanguageModel.layer>[0]
>["config"]
type OpenAiCompatConfig = Parameters<typeof makeOpenAiCompatResolution>[0]["config"]
const OpenAiReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

const buildOpenAiResponsesConfig = (hints: Option.Option<ProviderHints>): OpenAiResponsesConfig => {
  let config: OpenAiResponsesConfig = { store: false }
  if (Option.isSome(hints)) {
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_output_tokens: maxTokens.value }
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
    const reasoning = Schema.decodeUnknownOption(OpenAiReasoningEffort)(hints.value.reasoning)
    if (Option.isSome(reasoning) && reasoning.value !== "none") {
      config = {
        ...config,
        reasoning: { effort: reasoning.value, summary: "auto" },
      }
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
  config: OpenAiCompatConfig,
  apiKey: string,
) =>
  makeOpenAiCompatResolution({
    provider: "openai",
    modelName,
    apiKey,
    config,
    apiUrl: Option.none(),
  })

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
  config: OpenAiResponsesConfig,
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
  envApiKey: Option.Option<string>,
): ModelDriverContribution => ({
  id: "openai",
  name: "OpenAI",
  resolveModel: (modelName, authInfo, hints) =>
    Effect.gen(function* () {
      const auth = Option.fromNullishOr(authInfo)
      // Stored OAuth — handle inline with token refresh. The ChatGPT Codex
      // backend speaks the Responses shape, so the OAuth path uses
      // @effect/ai-openai instead of the chat-completions compat adapter.
      if (Option.isSome(auth) && auth.value.type === "oauth") {
        const config = buildOpenAiResponsesConfig(Option.fromNullishOr(hints))
        if (!isOpenAIOAuthModel(modelName)) {
          return yield* new ProviderAuthError({
            message: `Model "${modelName}" not available with ChatGPT OAuth`,
          })
        }
        return AiModel.make(
          "openai",
          modelName,
          makeOauthOpenAILayer(modelName, config, auth.value, credentialCellRef),
        )
      }

      // Stored API key takes precedence over env var
      let apiKey = envApiKey
      if (Option.isSome(auth) && auth.value.type === "api") {
        apiKey = Option.fromNullishOr(auth.value.key)
      }

      if (Option.isSome(apiKey)) {
        return makeApiKeyOpenAIResolution(
          modelName,
          buildOpenAiCompatConfig(Option.fromNullishOr(hints), true),
          apiKey.value,
        )
      }

      // Fail closed — no stored OAuth, no stored API key, no env var.
      // Previous versions fell through to `OpenAiClient.layer({})` and let
      // the unauthenticated request fail late as a generic HTTP error,
      // masking the real auth failure for non-TUI callers.
      return yield* new ProviderAuthError({
        message:
          "OpenAI credentials unavailable: no ChatGPT OAuth, stored API key, or OPENAI_API_KEY env var",
      })
    }),
  listModels: (baseCatalog, authInfo) => {
    // When OAuth is active, filter to allowed models + zero pricing
    const auth = Option.fromNullishOr(authInfo)
    if (Option.isNone(auth) || auth.value.type !== "oauth") return baseCatalog
    return baseCatalog
      .filter((model) => {
        if (model.provider !== "openai") return true
        const parts = model.id.split("/", 2)
        const modelName = Option.fromNullishOr(parts[1])
        return Option.isSome(modelName) && isOpenAIOAuthModel(modelName.value)
      })
      .map((model) => {
        if (model.provider !== "openai") return model
        return Model.make({ ...model, pricing: { input: 0, output: 0 } })
      })
  },
  auth: {
    methods: [
      AuthMethod.make({ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }),
      AuthMethod.make({
        type: "oauth",
        label: "ChatGPT Pro/Plus (device code)",
      }),
      AuthMethod.make({ type: "api", label: "Manually enter API key" }),
    ],
    authorize: (
      ctx,
    ): Effect.Effect<Option.Option<ProviderAuthorizationResult>, ProviderAuthError> =>
      Effect.gen(function* () {
        const allocate = Option.fromNullishOr(OAUTH_ALLOCATORS[ctx.methodIndex])
        if (Option.isNone(allocate)) return Option.none()
        const { flow, close } = yield* allocate.value.pipe(
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
        pendingCallbacks.set(ctx.authorizationId, {
          flow,
          close,
          timeoutFiber,
        })
        return Option.some(flow.authorization)
      }),
    callback: (ctx) =>
      Effect.gen(function* () {
        const entry = pendingCallbacks.get(ctx.authorizationId)
        pendingCallbacks.delete(ctx.authorizationId)
        const pendingEntry = Option.fromNullishOr(entry)
        if (Option.isNone(pendingEntry)) {
          return yield* new ProviderAuthError({
            message: "OpenAI OAuth callback state is missing or expired",
          })
        }
        yield* Fiber.interrupt(pendingEntry.value.timeoutFiber)
        const result = yield* pendingEntry.value.flow.callback(ctx.code).pipe(
          Effect.mapError(
            (e) =>
              new ProviderAuthError({
                message: `OpenAI OAuth callback failed: ${e.message}`,
                cause: e,
              }),
          ),
          Effect.ensuring(pendingEntry.value.close),
        )
        const accountId = Option.fromNullishOr(result.accountId)
        if (Option.isNone(accountId)) {
          return yield* ctx.persist({
            type: "oauth",
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
          })
        }
        yield* ctx.persist({
          type: "oauth",
          access: result.access,
          refresh: result.refresh,
          expires: result.expires,
          accountId: accountId.value,
        })
      }),
  },
})

export const OpenAIExtension = defineExtension({
  id: "@gent/provider-openai",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
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

    yield* host.register(
      "modelDriver",
      buildOpenAIModelDriver(credentialCellRef, pendingCallbacks, envApiKey),
    )
  }),
})
