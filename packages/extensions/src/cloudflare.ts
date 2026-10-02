import { Effect, Layer, Option, Predicate, Redacted, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import { Model as AiModel } from "effect/ai"
import type { OpenAiLanguageModel as OpenAiChatLanguageModel } from "@effect/ai-openai-compat"
import type * as ChatSdkModule from "@effect/ai-openai-compat"
import {
  AuthMethod,
  defineExtension,
  DriverError,
  DriverFailureId,
  ExtensionHost,
  Model,
  ModelId,
  type ModelCatalogView,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderHints,
  ProviderId,
} from "@gent/core/extensions/api"
import { apiKeyFrom, catalogModels, readOptionalEnv } from "./providers.js"
import { type ClassifierEntry, classifierModel, typeSafeDecisionModel } from "./typesafe.js"

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
const listWorkersAiModels = (catalog: ModelCatalogView): ReadonlyArray<Model> =>
  catalogModels(catalog, CATALOG_PROVIDER, Option.none()).map((model) =>
    Model.make({
      ...model,
      id: ModelId.make(`${DRIVER_ID}/${model.id.slice(CATALOG_PROVIDER.length + 1)}`),
      provider: ProviderId.make(DRIVER_ID),
    }),
  )

// ── clef decisions ──────────────────────────────────────────────────────────

/**
 * Cloudflare's classifier models, Clef (27B) and Clef Flash (9B): the cell's
 * `models.decide`, priced per million input tokens as the Workers AI model
 * pages list them. The pages name no output price; 0 here. models.dev lists
 * neither model.
 */
const CLASSIFIERS: ReadonlyArray<ClassifierEntry> = [
  { name: "clef", label: "Clef", pricing: { input: 0.24, output: 0 } },
  { name: "clef-flash", label: "Clef Flash", pricing: { input: 0.09, output: 0 } },
]

/**
 * Clef takes TypeSafe's System One body unchanged, its `model` field
 * `clef` or `clef-flash`, at the model's own Workers AI path. The TypeSafe
 * client posts to `{apiUrl}/systemone`; the request goes to
 * `/run/@cf/cloudflare/{model}` under the account instead.
 */
const clefRunPath =
  (modelName: string) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, (request) =>
      HttpClientRequest.setUrl(
        request,
        request.url.replace(/\/systemone$/, `/run/@cf/cloudflare/${modelName}`),
      ),
    )

/**
 * The Workers AI REST envelope, `{ result, success, errors, messages }`. The
 * Clef page shows no REST response, so the driver takes a bare System One
 * answer too.
 */
const WorkersAiEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optional(Schema.Json),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        code: Schema.optional(Schema.Union([Schema.Finite, Schema.String])),
      }),
    ),
  ),
})
type WorkersAiEnvelope = typeof WorkersAiEnvelope.Type
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(WorkersAiEnvelope))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** Headers that describe the body read, not the one written in its place. */
const BODY_HEADERS: ReadonlySet<string> = new Set(["content-length", "content-encoding"])

/** The response with `body` in place of the one read; its status and other headers stay. */
const withBody = (
  response: HttpClientResponse.HttpClientResponse,
  body: string,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    response.request,
    new Response(body, {
      status: response.status,
      headers: Object.fromEntries(
        Object.entries(response.headers).filter(([name]) => !BODY_HEADERS.has(name)),
      ),
    }),
  )

const isOk = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= 200 && response.status < 300

const statusFailure = (response: HttpClientResponse.HttpClientResponse, description: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request: response.request,
      response,
      description,
    }),
  })

/**
 * An envelope's failure as the status failure the TypeSafe client reads: the
 * first error's `message` and `code` in the body, where the client looks for
 * them. A failure Workers AI sent with a 2xx status keeps that status.
 */
const envelopeFailure = (
  response: HttpClientResponse.HttpClientResponse,
  envelope: WorkersAiEnvelope,
) => {
  const first = Option.fromUndefinedOr(envelope.errors?.[0])
  const message = Option.match(first, {
    onNone: () => "Workers AI reported a failure with no message",
    onSome: (error) => error.message,
  })
  const code = Option.flatMap(first, (error) => Option.fromUndefinedOr(error.code))
  const body = encodeJson({
    message,
    ...Option.match(code, { onNone: () => ({}), onSome: (value) => ({ code: String(value) }) }),
  })
  return statusFailure(withBody(response, body), message)
}

/**
 * System One's answer from a Workers AI response: the envelope's `result`,
 * or the body as it came when it is no envelope. A failed envelope fails with
 * its first error.
 */
const systemOneAnswer = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const text = yield* response.text
    const envelope = decodeEnvelope(text)
    if (Option.isNone(envelope)) {
      if (isOk(response)) return withBody(response, text)
      return yield* statusFailure(withBody(response, text), "non 2xx status code")
    }
    const result = Option.fromUndefinedOr(envelope.value.result).pipe(
      Option.filter(() => envelope.value.success && isOk(response)),
      Option.filter(Predicate.isNotNull),
    )
    if (Option.isNone(result)) return yield* envelopeFailure(response, envelope.value)
    return withBody(response, encodeJson(result.value))
  })

/**
 * The client's responses as System One bodies. The TypeSafe client fails a
 * non-2xx status before this client sees it; the failure's body is read here
 * too, so a Workers AI error names its own message.
 */
const unwrapEnvelope = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transformResponse(client, (effect) =>
    effect.pipe(
      Effect.catchIf(
        (
          error,
        ): error is HttpClientError.HttpClientError & {
          readonly reason: HttpClientError.StatusCodeError
        } => error.reason._tag === "StatusCodeError",
        (error) => Effect.succeed(error.reason.response),
      ),
      Effect.flatMap(systemOneAnswer),
    ),
  )

const isClassifier = (modelName: string): boolean =>
  CLASSIFIERS.some((entry) => entry.name === modelName)

// ── driver ──────────────────────────────────────────────────────────────────

/** The Cloudflare driver. `env` holds the variables setup read; a stored token or answer wins. */
export const buildCloudflareModelDriver = (env: CloudflareEnv): ModelDriverContribution => ({
  id: DRIVER_ID,
  name: "Cloudflare",
  envCredential: TOKEN_ENV,
  resolveModel: (modelName, authInfo, hints) =>
    Effect.gen(function* () {
      if (isClassifier(modelName)) {
        return yield* new DriverError({
          driver: DriverFailureId.make(DRIVER_ID),
          reason: `${DRIVER_ID}/${modelName} is a classifier model: it runs no turn; a cell asks it with models.decide`,
        })
      }
      const account = yield* accountFrom(Option.fromNullishOr(authInfo), env)
      const sdk = yield* loadChatSdk
      return AiModel.make(
        DRIVER_ID,
        modelName,
        chatModel(sdk, modelName, account, Option.fromNullishOr(hints)),
      )
    }),
  resolveDecisionModel: (modelName, authInfo) =>
    Effect.map(accountFrom(Option.fromNullishOr(authInfo), env), (account) =>
      typeSafeDecisionModel(modelName, {
        apiKey: account.token,
        apiUrl: accountRoot(account),
        transformClient: (client) =>
          client.pipe(clefRunPath(modelName), gatewayHeader(account.gatewayId), unwrapEnvelope),
      }),
    ),
  listModels: (catalog) =>
    Effect.succeed([
      ...listWorkersAiModels(catalog),
      ...CLASSIFIERS.map((entry) => classifierModel(DRIVER_ID, entry)),
    ]),
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
    yield* host.register("modelDriver", buildCloudflareModelDriver(env))
  }),
})
