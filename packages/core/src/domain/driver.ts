/**
 * Model driver primitives. A `ModelDriverContribution` wraps an LLM provider:
 * auth, `listModels`, and `resolveModel` returning a model that provides an
 * `effect/ai` `LanguageModel`. Each shipped provider extension registers
 * one. A driver that serves classifier
 * models also resolves them to an `effect/ai` `DecisionModel`
 * (`resolveDecisionModel`).
 *
 * An agent may name a driver with `driver: DriverRef`; otherwise the loop
 * derives the driver from the provider segment of its model id.
 *
 * The auth, hint, and resolution shapes live here too: they are
 * model-driver-only concepts and belong with their sole consumer.
 *
 * @module
 */
import { Context, type Duration, Effect, Option, Predicate, Schema, type Layer } from "effect"
import type { HttpClient } from "effect/http"
import {
  AiError,
  type DecisionModel,
  type LanguageModel,
  type Model as AiModel,
  type Response,
} from "effect/ai"
import { type CacheWriteByLifetime, Model, ModelId, ProviderId, ReasoningEffort } from "./agent.js"
import { omitUndefined } from "./guards.js"
import type { SessionId } from "./ids.js"
import type { ExtensionContext, ExtensionServiceError } from "./extension.js"
import type { Message } from "./message.js"

export const DriverFailureId = Schema.String.pipe(Schema.brand("DriverFailureId"))
export type DriverFailureId = typeof DriverFailureId.Type

// ── Auth method wire types ──

/**
 * One text field an API sign-in asks for after the key, such as an account
 * id. The answer is not a secret: the store keeps it beside the key as
 * `metadata[key]`. When `env` names a variable that is set, `/auth` does not
 * ask: the driver reads the variable instead. A prompt the driver cannot run
 * without is not `optional`: until it has an answer or its variable, the
 * sign-in is not ready, and the auth listing names it in `missing`.
 */
export const AuthPrompt = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  placeholder: Schema.optional(Schema.String),
  env: Schema.optional(Schema.String),
  optional: Schema.optional(Schema.Boolean),
})
export type AuthPrompt = typeof AuthPrompt.Type

/** The answers to an API sign-in's prompts, by prompt key. */
export const AuthMetadata = Schema.Record(Schema.String, Schema.String)
export type AuthMetadata = typeof AuthMetadata.Type

/**
 * How a provider signs in: an API key or an OAuth login. An API method may
 * ask `prompts` after the key, in order.
 */
export class AuthMethod extends Schema.Class<AuthMethod>("AuthMethod")({
  type: Schema.Literals(["api", "oauth"]),
  label: Schema.String,
  prompts: Schema.optional(Schema.Array(AuthPrompt)),
}) {}

export const AuthAuthorizationMethod = Schema.Literals(["auto", "code", "done"])
export type AuthAuthorizationMethod = typeof AuthAuthorizationMethod.Type

// ── Failure type ──

/** Failure raised when a driver lookup or dispatch fails. */
export class DriverError extends Schema.TaggedError<DriverError>()("DriverError", {
  driver: DriverFailureId,
  reason: Schema.String,
}) {}

// ── Shapes shared by every model driver ──

export class ProviderAuthError extends Schema.TaggedError<ProviderAuthError>()(
  "ProviderAuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * AiError metadata that carries a credential failure through a provider SDK.
 * The SDK keeps a reason's metadata but drops its cause, and it adds its own
 * text to the message. A driver attaches the failure here; the loop shows the
 * user the failure's own message.
 */
const CredentialFailureMetadata = Schema.Struct({
  gent: Schema.Struct({ credentialFailure: Schema.String }),
})

/** The AiError reason metadata that carries `error` to the loop. */
export const credentialFailureMetadata = (
  error: ProviderAuthError,
): typeof CredentialFailureMetadata.Type => ({ gent: { credentialFailure: error.message } })

/** The credential failure message a model error carries, if a driver attached one. */
// oxlint-disable-next-line effect/noUnknownParameters -- Model streams expose provider-specific error values.
export const credentialFailureMessage = (error: unknown): Option.Option<string> => {
  if (!AiError.isAiError(error) || !Predicate.hasProperty(error.reason, "metadata")) {
    return Option.none()
  }
  return Schema.decodeUnknownOption(CredentialFailureMetadata)(error.reason.metadata).pipe(
    Option.map((metadata) => metadata.gent.credentialFailure),
  )
}

/** Upstream Effect AI model returned by a model driver's `resolveModel`.
 *  It must be fully self-contained: auth, tool naming, cache control, and
 *  model metadata are all baked in. */
export type ProviderResolution = Layer.Layer<
  LanguageModel.LanguageModel | AiModel.ProviderName | AiModel.ModelName
> & {
  readonly "~effect/ai/Model": "~effect/ai/Model"
  readonly provider: string
}

/** Hints passed from the agent loop into `resolveModel`. Drivers bake these
 *  into their provider Config layer (e.g. `AnthropicLanguageModel.Config.max_tokens`). */
export interface ProviderHints {
  readonly reasoning?: ReasoningEffort
  readonly maxTokens?: number
  readonly temperature?: number
  /**
   * Stable conversation identity: OpenAI routes the prompt cache by it, and
   * Anthropic writes a prompt cache only for a request that names one.
   */
  readonly cacheKey?: string
  /**
   * The request is a spawned child session's (`isSpawnedSession`). A child
   * runs its steps back to back, so a driver may give its prompt cache a
   * shorter lifetime; the catalog names it as `Model.childPromptCacheTtlMs`.
   */
  readonly child?: boolean
  /**
   * The catalog's `Model.reasoning` for the resolved model. A driver sends no
   * reasoning effort to a model the catalog says does not reason; absent when
   * the catalog does not say.
   */
  readonly supportsReasoning?: boolean
  /**
   * The effort each earlier assistant run of the request's prompt was sent
   * at, in prompt order: one entry per run of consecutive assistant
   * messages, from the steps' receipts (`StreamEnded.reasoningLevel`). None
   * where no receipt says: a step on another model, a step stored before
   * receipts, a forked branch. A driver whose wire carries an effort change
   * inside the conversation rebuilds the changes from it, so the request's
   * earlier bytes stay the same. Absent on a request with no conversation
   * history to keep (the compaction summary).
   */
  readonly reasoningHistory?: ReadonlyArray<Option.Option<ReasoningEffort>>
}

/**
 * Read, then maybe write, the stored OAuth credential (token refresh path).
 * `f` receives the OAuth credential the store holds now (none when it holds
 * none) and returns a result plus the credential to write (none leaves the
 * store as it is). The store runs each provider's writes one at a time, and
 * every profile of the process shares the store, so a sign-in, a key change
 * and each profile's refresh never interleave.
 */
export type UpdateStoredOAuth = <A, E>(
  f: (
    stored: Option.Option<StoredOAuthCredentials>,
  ) => Effect.Effect<readonly [A, Option.Option<StoredOAuthCredentials>], E>,
) => Effect.Effect<A, E | ProviderAuthError>

const UpdateStoredOAuth = Schema.declare<UpdateStoredOAuth>((value): value is UpdateStoredOAuth =>
  Predicate.isFunction(value),
)

/**
 * The stored credential a driver receives in `resolveModel` and
 * `listModels`. An API key carries the answers to its method's prompts
 * (`metadata`, absent for a key stored without any). An OAuth sign-in carries
 * no token copy: the store is the one source, read and written through
 * `update`.
 */
export const ProviderAuthInfo = Schema.TaggedUnion({
  Api: { key: Schema.String, metadata: Schema.optional(AuthMetadata) },
  Oauth: { update: UpdateStoredOAuth },
})
export type ProviderAuthInfo = Schema.Schema.Type<typeof ProviderAuthInfo>

/** The OAuth fields of a stored credential. */
export interface StoredOAuthCredentials {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

/** Persist auth credentials — handed by `authorizeProvider` and `completeProviderAuth`
 *  to a model driver's auth handlers. */
export type PersistAuth = (
  auth:
    | { readonly type: "api"; readonly key: string }
    | {
        readonly type: "oauth"
        readonly access: string
        readonly refresh: string
        readonly expires: number
        readonly accountId?: string
      },
) => Effect.Effect<void, ProviderAuthError>

interface ProviderAuthorizeContext {
  readonly sessionId: SessionId
  readonly methodIndex: number
  readonly authorizationId: string
  readonly persist: PersistAuth
}

interface ProviderCallbackContext extends ProviderAuthorizeContext {
  readonly code?: string
}

export interface ProviderAuthorizationResult {
  readonly url: string
  readonly method: AuthAuthorizationMethod
  readonly instructions?: string
}

interface ProviderAuthContribution {
  readonly methods: ReadonlyArray<AuthMethod>
  readonly authorize?: (
    ctx: ProviderAuthorizeContext,
  ) => Effect.Effect<Option.Option<ProviderAuthorizationResult>, ProviderAuthError>
  readonly callback?: (ctx: ProviderCallbackContext) => Effect.Effect<void, ProviderAuthError>
}

// ── RetryPolicy — the driver knows its own transient failure shapes ──

/**
 * How the loop retries a failure from this driver. A typed `AiError` decides
 * by its own `isRetryable`; a raw error event the stream carried is
 * transient when it matches `transientStreamEvent`. The loop re-runs the
 * step for those. A request the provider refused as too long is not
 * transient: the loop hands the window off first, then runs the step again.
 * Providers name that refusal only in text, so `contextOverflow` reads it.
 */
export interface RetryPolicy {
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelay: number
  /** Upper bound of any delay, in milliseconds. A provider retry-after past it ends the retries. */
  readonly maxDelay: number
  /** Multiplier applied to the delay after each attempt. */
  readonly backoffFactor: number
  /** Attempts in total, the first call included. */
  readonly maxAttempts: number
  /** Wire shape of a mid-stream error event this driver treats as transient. */
  readonly transientStreamEvent: Schema.Top
  /** True when a failed request was refused as longer than the model accepts. */
  readonly contextOverflow: (cause: unknown) => boolean
}

/**
 * How providers word a refusal of a request as too long. One list: each
 * driver's policy reads it unless the driver names its own. Prior art: pi's
 * `utils/overflow.ts` and opencode's `provider-error.ts`, with the example
 * each pattern matches.
 *
 * Anthropic's HTTP 413 `request_too_large` is left out, although pi lists
 * it. It is a cap on the request body in bytes (32 MB; an image or document
 * too large), not on tokens: a token overflow comes back as "prompt is too
 * long". Handing the window off drops text history and keeps the attachment
 * that caused it, so the request fails as any refusal does.
 */
const CONTEXT_OVERFLOW_PATTERNS: ReadonlyArray<RegExp> = [
  /prompt is too long/i, // Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
  /exceed context limit/i, // Anthropic before 4.5: "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000"
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI: "Your input exceeds the context window of this model"
  /exceeds (?:the )?(?:model'?s )?maximum context length/i, // OpenAI-compatible proxies
  /input token count.*exceeds the maximum/i, // Google Gemini
  /maximum prompt length is \d+/i, // xAI
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter
  /is longer than the model'?s context length/i, // Together AI
  /too large for model with \d+ maximum context length/i, // Mistral
  /exceeds the available context size/i, // llama.cpp
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /context[_ ]length[_ ]exceeded/i, // OpenAI stream event code, and generic
  /model_context_window_exceeded/i, // Anthropic's stop reason, sent as an error code by some gateways
]

/** Rate limits can mention tokens too; they are never an overflow. */
const NOT_OVERFLOW_PATTERNS: ReadonlyArray<RegExp> = [/rate limit/i, /too many requests/i]

/**
 * The shared overflow test: the failure's message, and a stream event's
 * `code`, against the known wordings. A failure the SDK marks retryable (a
 * rate limit, an overloaded server) is never one.
 */
export const isContextOverflow = (cause: unknown): boolean => {
  if (AiError.isAiError(cause) && cause.isRetryable) return false
  let code = ""
  if (Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)) code = cause.code
  let message = String(cause)
  if (Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)) {
    message = cause.message
  }
  const text = `${code} ${message}`
  if (NOT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))
}

// ── Provider stop reason ──

/**
 * The provider's own word for why a step's stream stopped. Effect AI maps
 * that word to a `FinishReason` and keeps no copy of it, and a word its map
 * lacks becomes `"unknown"`: Anthropic's `model_context_window_exceeded`
 * does (`@effect/ai-anthropic` `internal/utilities.ts`). The loop provides
 * this service to each step's model stream. A driver that reads the wire
 * reports the word here, and the loop reads it when the step settles.
 */
export class ProviderStopReason extends Context.Service<
  ProviderStopReason,
  { readonly report: (reason: string) => Effect.Effect<void> }
>()("@gent/core/src/domain/driver/ProviderStopReason") {}

/** A driver reports the stream's raw stop reason; nothing listens outside a loop step. */
export const reportProviderStopReason = (reason: string): Effect.Effect<void> =>
  Effect.serviceOption(ProviderStopReason).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (listener) => listener.report(reason),
      }),
    ),
  )

/**
 * Stop reasons that say the context window filled while the model wrote:
 * the reply is cut, and the same window has no room to continue it.
 * Anthropic accepts a request whose input plus `max_tokens` passes the
 * window (Sonnet 4.5 and later) and ends the reply with this reason.
 */
const WINDOW_FULL_STOP_REASONS: ReadonlySet<string> = new Set(["model_context_window_exceeded"])

export const isWindowFullStopReason = (reason: string): boolean =>
  WINDOW_FULL_STOP_REASONS.has(reason)

/** Bounded backoff with no transient stream events; drivers spread and refine it. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  initialDelay: 2000,
  maxDelay: 30000,
  backoffFactor: 2,
  maxAttempts: 3,
  transientStreamEvent: Schema.Never,
  contextOverflow: isContextOverflow,
}

// ── model catalog ──

/**
 * One reasoning control a model accepts, as models.dev lists it under
 * `reasoning_options`: a list of effort values, an on/off toggle, or a
 * thinking budget in tokens. models.dev writes the "no reasoning" effort as
 * `null`; the catalog keeps it as `"none"`.
 */
export const ReasoningOption = Schema.Union([
  Schema.Struct({ type: Schema.Literal("effort"), values: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Finite),
    max: Schema.optional(Schema.Finite),
  }),
]).pipe(Schema.toTaggedUnion("type"))
export type ReasoningOption = typeof ReasoningOption.Type

/** A catalog model's price per million tokens, as models.dev lists it. */
const CatalogCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.optional(Schema.Finite),
  cacheWrite: Schema.optional(Schema.Finite),
})

/** A catalog model's token limits, as models.dev lists them. */
export const CatalogLimit = Schema.Struct({
  context: Schema.Finite,
  /** The input cap, where it is below the window (the GPT-5 family: 272k of 400k). */
  input: Schema.optional(Schema.Finite),
  /** The most output one reply may carry. */
  output: Schema.optional(Schema.Finite),
})

/**
 * One models.dev model, decoded field by field: an odd field drops itself,
 * never the model. `id` is the model's key under its provider.
 */
export const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  cost: Schema.optional(CatalogCost),
  limit: Schema.optional(CatalogLimit),
  releaseDate: Schema.optional(Schema.String),
  /** False for embedding, image and other models the agent loop cannot drive. */
  toolCall: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  /** False for a model that refuses a sampling temperature. */
  temperature: Schema.optional(Schema.Boolean),
  /** The reasoning controls the model accepts; absent when the catalog lists none. */
  reasoningOptions: Schema.optional(Schema.Array(ReasoningOption)),
  /**
   * The assistant-message field that carries the model's reasoning back to it
   * (`interleaved.field`, such as `reasoning_content`).
   */
  reasoningField: Schema.optional(Schema.String),
  /** The model's own AI SDK package (`provider.npm`), over its provider's. */
  npm: Schema.optional(Schema.String),
  /** The model's own base URL (`provider.api`), over its provider's. */
  api: Schema.optional(Schema.String),
  /** The model's request protocol (models.dev `provider.shape`: `responses` or `completions`). */
  protocol: Schema.optional(Schema.String),
  /** True for a decision model (`type: "decision"`): it answers typed decisions, never a turn. */
  decision: Schema.optional(Schema.Boolean),
})
export type CatalogModel = typeof CatalogModel.Type

/**
 * One models.dev provider: its env variables, its AI SDK package and base URL,
 * and its models in catalog order. A provider served by both sources holds
 * its decision models after its chat models.
 */
export const CatalogProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  env: Schema.Array(Schema.String),
  npm: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  models: Schema.Array(CatalogModel),
})
export type CatalogProvider = typeof CatalogProvider.Type

/** The models.dev catalog a driver reads, by models.dev provider id. */
export interface ModelCatalogView {
  readonly provider: (id: string) => Option.Option<CatalogProvider>
}

/**
 * The effort levels the catalog lists for the model, lowest first; empty when
 * it lists no effort list (a thinking budget or a toggle only).
 */
export const acceptedEfforts = (entry: CatalogModel): ReadonlyArray<ReasoningEffort> =>
  Option.match(
    Option.fromUndefinedOr(
      (entry.reasoningOptions ?? []).find((option) => option.type === "effort"),
    ),
    {
      onNone: () => [],
      onSome: (option) => ReasoningEffort.literals.filter((level) => option.values.includes(level)),
    },
  )

/**
 * A catalog model as gent's `Model`, under `providerId` (a driver id, which
 * may differ from the catalog provider's). A decision model is a classifier.
 * `efforts` are the levels its requests name (`Model.efforts`): by default
 * the catalog's effort list; an API class that plans a level otherwise
 * passes its own (`ApiClassContribution.efforts`).
 */
export const modelFromCatalog = (
  providerId: string,
  entry: CatalogModel,
  efforts: (entry: CatalogModel) => ReadonlyArray<ReasoningEffort> = acceptedEfforts,
): Model => {
  const levels = efforts(entry)
  const model = Model.make({
    id: ModelId.make(`${providerId}/${entry.id}`),
    name: entry.name,
    provider: ProviderId.make(providerId),
    ...omitUndefined({
      contextLength: entry.limit?.context,
      inputLimit: entry.limit?.input,
      outputLimit: entry.limit?.output,
      pricing: Option.getOrUndefined(
        Option.map(Option.fromUndefinedOr(entry.cost), (cost) => ({
          input: cost.input,
          output: cost.output,
          ...omitUndefined({ cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite }),
        })),
      ),
      releaseDate: entry.releaseDate,
      reasoning: entry.reasoning,
      efforts: Option.getOrUndefined(Option.liftPredicate(levels, (each) => each.length > 0)),
    }),
  })
  if (entry.decision !== true) return model
  return Model.make({ ...model, kind: "classifier" })
}

/**
 * The catalog entry of one model of `providerId`; none when the catalog has
 * no entry for it. An entry that names no AI SDK package or base URL of its
 * own takes its provider's.
 */
export const catalogModelEntry = (
  catalog: ModelCatalogView,
  providerId: string,
  modelKey: string,
): Option.Option<CatalogModel> =>
  Option.flatMap(catalog.provider(providerId), (provider) =>
    Option.map(
      Option.fromUndefinedOr(provider.models.find((entry) => entry.id === modelKey)),
      (entry) => ({
        ...entry,
        ...omitUndefined({ npm: entry.npm ?? provider.npm, api: entry.api ?? provider.api }),
      }),
    ),
  )

/**
 * One fact a driver knows better than models.dev, applied to the catalog
 * entries of the driver's catalog provider whose id `match` accepts, before
 * the driver lists or resolves them. `receipt` names the source that shows
 * models.dev wrong; delete the row when models.dev is fixed.
 */
export interface CatalogOverride {
  readonly match: RegExp
  readonly patch: (entry: CatalogModel) => CatalogModel
  readonly receipt: string
}

// ── ApiClassContribution — one wire protocol ──

/**
 * Where a provider's requests go and how they are signed, as an adapter
 * names it for one model. `apiKey` is the protocol's own key header; none
 * when `transformClient` signs. `baseUrl` none takes the catalog entry's
 * base URL, else the class default.
 */
export interface ApiEndpoint {
  readonly apiKey: Option.Option<string>
  readonly baseUrl: Option.Option<string>
  readonly transformClient: Option.Option<(client: HttpClient.HttpClient) => HttpClient.HttpClient>
}

/** What core hands an API class for one model: the catalog entry, the endpoint and the hints. */
export interface ApiClassRequest extends ApiEndpoint {
  /** The driver id: the Effect AI provider name of the model. */
  readonly providerId: string
  /** The entry, with its provider's package and base URL where it names none (`catalogModelEntry`). */
  readonly model: CatalogModel
  readonly hints: Option.Option<ProviderHints>
}

/**
 * One wire protocol gent speaks, such as the Messages API: it turns a
 * catalog entry plus an endpoint into an Effect AI model, and plans the
 * request (effort, thinking, sampling) from the entry's `reasoningOptions`
 * and `temperature`. Core picks the class of a model by the entry's
 * `protocol`, then its AI SDK package (`npm`); a model no class speaks is
 * not listed and does not resolve.
 */
export interface ApiClassContribution {
  readonly id: string
  /** The models.dev AI SDK packages this class speaks. */
  readonly npm: ReadonlyArray<string>
  /** The models.dev `provider.shape` values this class speaks. */
  readonly protocols: ReadonlyArray<string>
  /** How long a prompt stays cached; none: the model never goes cold. */
  readonly promptCacheTtl: Option.Option<Duration.Duration>
  /**
   * The effort levels this class's requests name for `entry`, lowest first
   * (`Model.efforts`), when its plan differs from the catalog's effort list:
   * a class that turns reasoning off for `none` lists `none`. Absent: the
   * catalog's list (`acceptedEfforts`).
   */
  readonly efforts?: (entry: CatalogModel) => ReadonlyArray<ReasoningEffort>
  readonly resolveModel: (
    request: ApiClassRequest,
  ) => Effect.Effect<ProviderResolution, DriverError>
}

/** The class that speaks `entry`: its protocol first, then its AI SDK package. */
export const apiClassFor = (
  classes: Iterable<ApiClassContribution>,
  entry: CatalogModel,
): Option.Option<ApiClassContribution> => {
  const all = [...classes]
  const byProtocol = Option.flatMap(Option.fromUndefinedOr(entry.protocol), (protocol) =>
    Option.fromUndefinedOr(all.find((each) => each.protocols.includes(protocol))),
  )
  return Option.orElse(byProtocol, () =>
    Option.flatMap(Option.fromUndefinedOr(entry.npm), (npm) =>
      Option.fromUndefinedOr(all.find((each) => each.npm.includes(npm))),
    ),
  )
}

// ── ModelDriverContribution — provider-shaped driver ──

/**
 * Registers a model provider as a driver: the adapter of one models.dev
 * provider. `id` doubles as the driver id, and `auth` wires the OAuth/API
 * key flow. The driver registry routes a `DriverRef({ _tag: "Model", id })`
 * to the matching contribution.
 *
 * A driver names only what models.dev lacks. With an `endpoint` and no
 * `resolveModel`, core resolves a model itself: the catalog entry, the API
 * class that speaks it, and the endpoint. With no `listModels`, core lists
 * the catalog provider's models some class speaks. A driver whose requests
 * need more than an endpoint (an OAuth reply rewrite) keeps `resolveModel`.
 */
export interface ModelDriverContribution {
  /** Driver id — matches the provider id segment in `provider/model` model names. */
  readonly id: string
  /** Display name; `/auth` shows it for the driver's sign-in. */
  readonly name: string
  /** The models.dev provider the driver serves; the driver id when absent. */
  readonly catalogProvider?: string
  /** Facts the driver knows better than models.dev, applied to its catalog entries. */
  readonly overrides?: ReadonlyArray<CatalogOverride>
  /**
   * Model names the driver shipped before models.dev named the model, each
   * to the name its catalog lists now. Core resolves an alias, for a turn's
   * model metadata and its dispatch alike and for `models.decide`, as the
   * name it stands for; lists show only the current names. An alias that
   * equals a name the driver's catalog view lists is ignored: the real model
   * wins.
   */
  readonly aliases?: Readonly<Record<string, string>>
  /**
   * Where one model's requests go and how they are signed. A missing
   * credential fails with `ProviderAuthError`.
   */
  readonly endpoint?: (
    modelName: string,
    authInfo?: ProviderAuthInfo,
    hints?: ProviderHints,
  ) => Effect.Effect<ApiEndpoint, ProviderAuthError>
  /**
   * Resolve a model name to an Effect AI model, in place of core's catalog,
   * class and endpoint composition. A missing credential fails with
   * `ProviderAuthError`; a model the driver cannot serve fails with
   * `DriverError`. A defect is a bug. Core passes the models.dev catalog it
   * holds, with the driver's overrides applied; a direct caller that passes
   * none resolves without catalog facts.
   */
  readonly resolveModel?: (
    modelName: string,
    authInfo?: ProviderAuthInfo,
    hints?: ProviderHints,
    catalog?: ModelCatalogView,
  ) => Effect.Effect<ProviderResolution, ProviderAuthError | DriverError>
  /**
   * Resolve a classifier model name to an Effect AI `DecisionModel` with its
   * auth and endpoint baked in. The driver's list holds those models with
   * `kind: "classifier"`; core's list adds the catalog provider's decision
   * models for a driver that declares it. Declare it only when the list holds
   * a classifier with or without a credential: a credential for a driver that
   * declares it makes the cell's `models.decide` guideline show, and no
   * catalog is read to check.
   */
  readonly resolveDecisionModel?: (
    modelName: string,
    authInfo?: ProviderAuthInfo,
  ) => Effect.Effect<Layer.Layer<DecisionModel.DecisionModel>, ProviderAuthError>
  /**
   * The driver's own models, in place of core's list. Core reads the
   * models.dev catalog and hands it in, with the driver's overrides applied;
   * the driver picks its provider's entries (`modelFromCatalog`) and stamps
   * what models.dev does not carry. `authInfo` is the driver's stored
   * credential, when there is one. Core concatenates every list.
   */
  readonly listModels?: (
    catalog: ModelCatalogView,
    authInfo?: ProviderAuthInfo,
  ) => Effect.Effect<ReadonlyArray<Model>, DriverError | ProviderAuthError>
  /** Auth configuration — OAuth + API key methods + handlers. */
  readonly auth?: ProviderAuthContribution
  /**
   * The id of the driver whose sign-in this driver uses, for two drivers one
   * account serves (OpenCode's Zen and Go gateways take one key). Core hands
   * this driver that driver's stored credential, lists one sign-in for both,
   * and hides this driver's own `auth`. A credential stored under this
   * driver's own id (from before it shared) serves both while the owner has
   * none stored, and signing out removes it too.
   *
   * Sharing is one hop: the named driver must itself name none. When the
   * profile registers no such driver, or the named one shares another's
   * sign-in (a chain or a cycle), this driver keeps a sign-in of its own,
   * with its own `auth`, and the auth listing logs a warning for the chain.
   */
  readonly credentialFrom?: string
  /**
   * The environment variable the driver reads a credential from when nothing
   * is stored (e.g. `ANTHROPIC_API_KEY`). The auth listing reports a set one
   * as `source: "env"`, so a user with only that variable is not asked to
   * sign in. A driver that shares a sign-in still reads only its own.
   */
  readonly envCredential?: string
  /** Retry policy for this driver's transient failures; `DEFAULT_RETRY_POLICY` when absent. */
  readonly retry?: RetryPolicy
  /**
   * A response's cache writes split by the lifetime of the entries they wrote,
   * read from its finish part's provider metadata. A driver whose request
   * mixes lifetimes names it, so each part is priced at its own rate
   * (`ModelPricing.cacheWriteByLifetime`). Absent, every write takes the
   * catalog's `cacheWrite` rate.
   */
  readonly cacheWritesByLifetime?: (
    metadata: Response.ProviderMetadata,
  ) => ReadonlyArray<CacheWriteByLifetime>
}

// ── ModelRouterContribution — virtual models ──

/**
 * One choice of a virtual model: a concrete model, an effort, or both. A
 * choice with no model keeps the model the branch runs on and sets only the
 * effort. `reason` says when the choice fits; the router's classifier reads it.
 */
export interface VirtualModelChoice {
  readonly model?: ModelId
  readonly effort?: ReasoningEffort
  readonly reason: string
}

/**
 * A model id that names no model: `<router id>/<name>` picks one of its
 * choices at the start of each turn. Selectable wherever a model id goes.
 */
export interface VirtualModel {
  readonly name: string
  /** What the picker and the status row show (`Auto`). */
  readonly label: string
  /** At least one; at least one names a model. */
  readonly choices: ReadonlyArray<VirtualModelChoice>
  /** The index of the default choice: a turn takes it when no route answers. */
  readonly fallback: number
}

/** A virtual model the router could not offer, and why; it shows as a catalog failure. */
export interface VirtualModelProblem {
  readonly name: string
  readonly reason: string
}

/** The model the branch's last request ran on, and what a switch away from it costs. */
export interface ModelRouteCurrent {
  readonly model: Model
  /** The provider still holds that request's prompt cache; a switch writes it again. */
  readonly warm: boolean
  /** The estimate of the prefix a switch writes again on the new model, in tokens. */
  readonly historyTokens: number
}

/** What a router reads to pick a choice for one turn. */
export interface ModelRouteInput {
  /** The selected virtual model. */
  readonly model: VirtualModel
  /** The model-visible messages, the newest (a user message) last. */
  readonly messages: ReadonlyArray<Message>
  /**
   * Aligned with `model.choices`: the catalog entry each choice runs on (a
   * choice with no model, the current model's); none for a model the
   * catalog does not list, or whose driver has no sign-in that `/auth`
   * lists as ready: the turn cannot run it.
   */
  readonly candidates: ReadonlyArray<Option.Option<Model>>
  /** None on the branch's first request. */
  readonly current: Option.Option<ModelRouteCurrent>
  /** The session is a spawned child: its requests ask for the child cache lifetime. */
  readonly child: boolean
}

/** The choice a router picked, and why, in a few words. */
export interface ModelRouteDecision {
  readonly choice: number
  readonly reason: string
}

/**
 * A router of virtual models. Its `id` is the provider segment of the ids it
 * serves (`router/auto`); a model driver with the same id wins. Core routes
 * once per turn, at its first step: it calls `route` (10 s at most), records
 * the pick as a `ModelRouted` event, and runs every step of the turn on it.
 * A route that fails, times out or picks a choice the turn cannot run takes
 * the current model when it is a choice, else the default choice. The router
 * asks classifiers through `ExtensionContext.Models`.
 */
export interface ModelRouterContribution {
  readonly id: string
  readonly name: string
  readonly models: ReadonlyArray<VirtualModel>
  readonly problems?: ReadonlyArray<VirtualModelProblem>
  readonly route: (
    input: ModelRouteInput,
  ) => Effect.Effect<ModelRouteDecision, ExtensionServiceError, ExtensionContext>
}
