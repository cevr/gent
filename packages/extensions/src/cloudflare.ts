import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Model as AiModel } from "effect/ai"
import type { OpenAiLanguageModel as OpenAiChatLanguageModel } from "@effect/ai-openai-compat"
import type * as ChatSdkModule from "@effect/ai-openai-compat"
import {
  AuthMethod,
  defineExtension,
  ExtensionHost,
  Model,
  ModelId,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
  ProviderId,
} from "@gent/core/extensions/api"
import {
  apiKeyFrom,
  type CatalogSource,
  catalogSource,
  driverListModels,
  readOptionalEnv,
} from "./providers.js"

// Test seam: only tests read buildCloudflareModelDriver, which lets a test
// run the driver against a fake fetch and a fixture catalog.

/**
 * Cloudflare's REST API for AI on `api.cloudflare.com`: Workers AI models
 * (`@cf/...`) and the third-party models AI Gateway serves (`author/model`),
 * both over OpenAI Chat Completions at `/accounts/{account}/ai/v1`. One
 * Cloudflare API token signs every request (`Authorization: Bearer`); the
 * sign-in also asks the account id, and an AI Gateway id that routes the
 * requests through that gateway (`cf-aig-gateway-id`).
 *
 * Docs: developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility
 * and developers.cloudflare.com/ai-gateway/usage/rest-api (read 2026-10-02).
 */

// ── account ─────────────────────────────────────────────────────────────────

const DRIVER_ID = "cloudflare"
const TOKEN_ENV = "CLOUDFLARE_API_TOKEN"
const ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID"
const GATEWAY_ENV = "CLOUDFLARE_GATEWAY_ID"
const API_ORIGIN = "https://api.cloudflare.com/client/v4"

/** The sign-in's prompt keys: the answers sit beside the token as metadata. */
const ACCOUNT_KEY = "accountId"
const GATEWAY_KEY = "gatewayId"

/** The variables the driver reads at setup; a stored token or answer wins over each. */
export interface CloudflareEnv {
  readonly token: Option.Option<string>
  readonly accountId: Option.Option<string>
  readonly gatewayId: Option.Option<string>
}

/** Where a request goes and how it is signed. */
interface Account {
  readonly token: string
  readonly accountId: string
  /** None: the requests go to Workers AI with no gateway. */
  readonly gatewayId: Option.Option<string>
}

/** A non-empty answer the sign-in stored for `key`. */
const storedAnswer = (authInfo: Option.Option<ProviderAuthInfo>, key: string) =>
  authInfo.pipe(
    Option.flatMap((auth) => {
      if (auth._tag !== "Api") return Option.none()
      return Option.fromUndefinedOr(auth.metadata?.[key])
    }),
    Option.filter((answer) => answer.trim() !== ""),
  )

/**
 * The token, the account and the gateway a request uses: each stored with
 * the sign-in first, then its variable. A missing token or account fails and
 * names the variable and `/auth`; a missing gateway means none.
 */
const accountFrom = (
  authInfo: Option.Option<ProviderAuthInfo>,
  env: CloudflareEnv,
): Effect.Effect<Account, ProviderAuthError> =>
  Effect.gen(function* () {
    const token = yield* Effect.fromOption(apiKeyFrom(authInfo, env.token)).pipe(
      Effect.mapError(
        () =>
          new ProviderAuthError({
            message: `Cloudflare credentials unavailable: no stored API token and no ${TOKEN_ENV} env var; sign in with /auth`,
          }),
      ),
    )
    const accountId = yield* Effect.fromOption(
      Option.orElse(storedAnswer(authInfo, ACCOUNT_KEY), () => env.accountId),
    ).pipe(
      Effect.mapError(
        () =>
          new ProviderAuthError({
            message: `Cloudflare account id unavailable: none stored with the sign-in and no ${ACCOUNT_ENV} env var; sign in again with /auth`,
          }),
      ),
    )
    const gatewayId = Option.orElse(storedAnswer(authInfo, GATEWAY_KEY), () => env.gatewayId)
    return { token, accountId, gatewayId }
  })

/** The account's API root: `/ai/v1` serves Chat Completions, `/ai/run` a model's own body. */
const accountRoot = (account: Account): string =>
  `${API_ORIGIN}/accounts/${encodeURIComponent(account.accountId)}/ai`

/**
 * With a gateway id, every request names the gateway: AI Gateway then logs,
 * caches and bills it. Workers AI (`@cf/`) models need the header to go
 * through a gateway at all; third-party models default to the account's
 * default gateway without it.
 */
const gatewayHeader =
  (gatewayId: Option.Option<string>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    Option.match(gatewayId, {
      onNone: () => client,
      onSome: (id) =>
        HttpClient.mapRequest(client, (request) =>
          HttpClientRequest.setHeader(request, "cf-aig-gateway-id", id),
        ),
    })

// ── chat completions ────────────────────────────────────────────────────────

type ChatSdk = typeof ChatSdkModule
type ChatConfig = NonNullable<Parameters<typeof OpenAiChatLanguageModel.layer>[0]["config"]>

// oxlint-disable-next-line effect/noDynamicImports -- the SDK loads at the first model build, not at launch
const loadChatSdk = Effect.promise((): Promise<ChatSdk> => import("@effect/ai-openai-compat"))

/**
 * The Chat Completions request: tools without strict schemas, which the
 * Workers AI models do not all take, the output cap, and a `temperature` only
 * for a model the catalog says does not reason. The catalog lists no
 * reasoning controls for a Workers AI model, so the request names no effort.
 */
const chatConfig = (hints: Option.Option<ProviderHints>): ChatConfig => {
  let config: ChatConfig = { strictJsonSchema: false }
  const maxTokens = Option.flatMap(hints, (value) => Option.fromNullishOr(value.maxTokens))
  if (Option.isSome(maxTokens)) config = { ...config, max_output_tokens: maxTokens.value }
  const temperature = hints.pipe(
    Option.filter((value) => value.supportsReasoning === false),
    Option.flatMap((value) => Option.fromNullishOr(value.temperature)),
  )
  if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
  return config
}

const chatModel = (
  { OpenAiClient, OpenAiLanguageModel }: ChatSdk,
  modelName: string,
  account: Account,
  hints: Option.Option<ProviderHints>,
) => {
  const client = OpenAiClient.layer({
    apiKey: Redacted.make(account.token),
    apiUrl: `${accountRoot(account)}/v1`,
    transformClient: gatewayHeader(account.gatewayId),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return OpenAiLanguageModel.layer({ model: modelName, config: chatConfig(hints) }).pipe(
    Layer.provide(client),
  )
}

// ── catalog ─────────────────────────────────────────────────────────────────

/**
 * models.dev lists the Workers AI models under this provider, with the
 * account's `/ai/v1` as their API. Its `cloudflare-ai-gateway` list names the
 * `ai-gateway-provider` package, which speaks the gateway's provider-native
 * routes, not this one, so the picker shows the Workers AI models only; a
 * third-party `author/model` id still resolves when an agent names it.
 */
const CATALOG_PROVIDER = "cloudflare-workers-ai"

/**
 * The Workers AI models under this driver's id. They speak Chat Completions,
 * whose upstreams cache implicitly with no write price, so none has a cache
 * lifetime.
 */
const listWorkersAiModels = (catalog: CatalogSource) =>
  driverListModels(catalog, CATALOG_PROVIDER, Option.none())().pipe(
    Effect.map((models) =>
      models.map((model) =>
        Model.make({
          ...model,
          id: ModelId.make(`${DRIVER_ID}/${model.id.slice(CATALOG_PROVIDER.length + 1)}`),
          provider: ProviderId.make(DRIVER_ID),
        }),
      ),
    ),
  )

// ── driver ──────────────────────────────────────────────────────────────────

/** The Cloudflare driver. `env` holds the variables setup read; a stored token or answer wins. */
export const buildCloudflareModelDriver = (
  env: CloudflareEnv,
  catalog: CatalogSource,
): ModelDriverContribution => ({
  id: DRIVER_ID,
  name: "Cloudflare",
  envCredential: TOKEN_ENV,
  resolveModel: (modelName, authInfo, hints) =>
    Effect.gen(function* () {
      const account = yield* accountFrom(Option.fromNullishOr(authInfo), env)
      const sdk = yield* loadChatSdk
      return AiModel.make(
        DRIVER_ID,
        modelName,
        chatModel(sdk, modelName, account, Option.fromNullishOr(hints)),
      )
    }),
  listModels: () => listWorkersAiModels(catalog),
  auth: {
    methods: [
      AuthMethod.make({
        type: "api",
        label: "Cloudflare API token (Workers AI read and edit)",
        prompts: [
          {
            key: ACCOUNT_KEY,
            label: "Account ID",
            placeholder: "32 hex characters, from the dashboard",
            env: ACCOUNT_ENV,
          },
          {
            key: GATEWAY_KEY,
            label: "AI Gateway ID",
            placeholder: "optional: leave empty for no gateway",
            env: GATEWAY_ENV,
          },
        ],
      }),
    ],
  },
})

export const CloudflareExtension = defineExtension({
  id: "@gent/provider-cloudflare",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    const env: CloudflareEnv = {
      token: yield* readOptionalEnv(TOKEN_ENV),
      accountId: yield* readOptionalEnv(ACCOUNT_ENV),
      gatewayId: yield* readOptionalEnv(GATEWAY_ENV),
    }
    const catalog = yield* catalogSource(host.home)
    yield* host.register("modelDriver", buildCloudflareModelDriver(env, catalog))
  }),
})
