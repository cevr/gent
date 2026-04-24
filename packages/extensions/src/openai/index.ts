import { Effect, Layer, Redacted, Ref } from "effect"
import {
  defineExtension,
  AuthMethod,
  Model,
  ProviderAuthError,
  type ModelDriverContribution,
  type ProviderAuthInfo,
  type ProviderHints,
  type ProviderResolution,
} from "@gent/core/extensions/api"
import { authorizeOpenAI, OPENAI_OAUTH_ALLOWED_MODELS } from "./oauth.js"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { FetchHttpClient } from "effect/unstable/http"
import {
  OpenAICredentialService,
  EMPTY_CREDENTIAL_CELL,
  type CredentialCacheCell,
} from "./credential-service.js"
import { buildCodexTransformClient } from "./codex-transform.js"

// Provider extensions read env at setup time (outside Effect runtime, no Config available).
// Lint override in .oxlintrc.json allows process.env in extensions/**/provider dirs.
const readEnv = (name: string): string | undefined => {
  const val = process.env[name]
  return val !== undefined && val !== "" ? val : undefined
}

type OAuthCallback = (code?: string) => Promise<{
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
}>

type PendingCallbackEntry = {
  readonly cb: OAuthCallback
  readonly timeoutId: ReturnType<typeof setTimeout>
}

const buildOpenAiConfig = (hints?: ProviderHints) => {
  const config: Record<string, unknown> = {}
  if (hints?.maxTokens !== undefined) config["max_tokens"] = hints.maxTokens
  if (hints?.temperature !== undefined) config["temperature"] = hints.temperature
  if (hints?.reasoning !== undefined && hints.reasoning !== "none") {
    config["reasoning_effort"] = hints.reasoning
  }
  return config
}

// ── Layer construction helpers ──

/**
 * API-key path: plain `OpenAiClient.layer` over `FetchHttpClient`. No
 * Codex transform — the Codex backend rewrite + OAuth headers are
 * specific to the ChatGPT OAuth path.
 */
const makeApiKeyOpenAILayer = (
  modelName: string,
  config: Record<string, unknown>,
  apiKey: string,
) => {
  const clientLayer = OpenAiClient.layer({
    apiKey: Redacted.make(apiKey),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return OpenAiLanguageModel.layer({ model: modelName, config }).pipe(Layer.provide(clientLayer))
}

/**
 * OAuth path: builds `OpenAiClient.layer` with `transformClient` set to
 * the Codex transform middleware (auth headers, URL/body/beta rewrite,
 * 401 recovery). No `apiKey` — the SDK only injects Bearer auth when
 * `apiKey !== undefined`, so omitting it lets our middleware own the
 * Authorization header without a "scrub-the-placeholder" coupling.
 *
 * The credential cache cell `Ref` is passed in from extension-closure
 * scope (built once in `modelDrivers()` via `Ref.makeUnsafe`), not
 * allocated per layer build. Without this hoist, every
 * `Provider.stream`/`Provider.generate` call would rebuild the service
 * layer and reset the cache, killing credential reuse and the rotated
 * refresh-token contract.
 */
const makeOauthOpenAILayer = (
  modelName: string,
  config: Record<string, unknown>,
  authInfo: ProviderAuthInfo,
  credentialCellRef: Ref.Ref<CredentialCacheCell>,
) => {
  const credentialLayer = OpenAICredentialService.layerFromRef(credentialCellRef, authInfo)

  const clientLayer = Layer.unwrap(
    Effect.gen(function* () {
      const creds = yield* OpenAICredentialService
      return OpenAiClient.layer({
        transformClient: buildCodexTransformClient(creds),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  ).pipe(Layer.provide(credentialLayer))

  return OpenAiLanguageModel.layer({ model: modelName, config }).pipe(Layer.provide(clientLayer))
}

/**
 * Build the model-driver contribution given a pre-allocated credential
 * cache cell `Ref`. Extracted from the inline `modelDrivers` factory so
 * tests can inject their own `Ref` and assert that two `resolveModel`
 * calls share the same closure-owned cell.
 */
export const buildOpenAIModelDriver = (
  credentialCellRef: Ref.Ref<CredentialCacheCell>,
  pendingCallbacks: Map<string, PendingCallbackEntry>,
): ModelDriverContribution => ({
  id: "openai",
  name: "OpenAI",
  resolveModel: (modelName, authInfo, hints): ProviderResolution => {
    const config = buildOpenAiConfig(hints)

    // Stored OAuth — handle inline with token refresh
    // Uses openai-compat (Chat Completions) since the Codex endpoint
    // expects that format
    if (authInfo?.type === "oauth") {
      if (!OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)) {
        throw new Error(`Model "${modelName}" not available with ChatGPT OAuth`)
      }
      return { layer: makeOauthOpenAILayer(modelName, config, authInfo, credentialCellRef) }
    }

    // Stored API key takes precedence over env var
    const storedApiKey =
      authInfo?.type === "api" && authInfo.key !== undefined ? authInfo.key : undefined
    const envApiKey = readEnv("OPENAI_API_KEY")
    const apiKey = storedApiKey ?? envApiKey

    if (apiKey !== undefined) {
      return { layer: makeApiKeyOpenAILayer(modelName, config, apiKey) }
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
    authorize: (ctx) =>
      Effect.tryPromise({
        try: async () => {
          if (ctx.methodIndex !== 0) return undefined
          const { authorization, callback: cb } = await authorizeOpenAI()
          // Mirror oauth.ts pendingOAuth TTL (5 min). Without this an
          // abandoned auth attempt — user starts the flow, never
          // completes — leaves the callback closure resident until
          // extension teardown.
          const timeoutId = setTimeout(
            () => {
              pendingCallbacks.delete(ctx.authorizationId)
            },
            5 * 60 * 1000,
          )
          pendingCallbacks.set(ctx.authorizationId, { cb, timeoutId })
          return authorization
        },
        catch: (e) =>
          new ProviderAuthError({
            message: `OpenAI OAuth authorization failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
            cause: e,
          }),
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
        clearTimeout(entry.timeoutId)
        const cb = entry.cb
        const result = yield* Effect.tryPromise({
          try: () => cb(ctx.code),
          catch: (e) =>
            new ProviderAuthError({
              message: `OpenAI OAuth callback failed: ${e instanceof Error ? e.message : String(e)}`,
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
      }),
  },
})

export const OpenAIExtension = defineExtension({
  id: "@gent/provider-openai",
  modelDrivers: () => {
    // Credential cache cell hoisted to extension-closure scope so it
    // survives across `resolveModel` calls. One extension instance →
    // one cell that lives until the runtime tears the extension down.
    // `Ref.makeUnsafe` is the right primitive here because
    // `modelDrivers()` is sync (no Effect runtime).
    const credentialCellRef = Ref.makeUnsafe<CredentialCacheCell>(EMPTY_CREDENTIAL_CELL)
    // Pending OAuth callbacks keyed by authorizationId. Entries
    // self-clear on a 5-min TTL so abandoned auth attempts don't leak.
    const pendingCallbacks = new Map<string, PendingCallbackEntry>()

    return [buildOpenAIModelDriver(credentialCellRef, pendingCallbacks)]
  },
})
