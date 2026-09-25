/**
 * Model driver primitives. A `ModelDriverContribution` wraps an LLM provider:
 * auth, `listModels`, and `resolveModel` returning a model that provides an
 * `effect/unstable/ai` `LanguageModel`. The gent providers
 * (anthropic, openai) register one each.
 *
 * An agent may name a driver with `driver: DriverRef`; otherwise the loop
 * derives the driver from the provider segment of its model id.
 *
 * The auth, hint, and resolution shapes live here too: they are
 * model-driver-only concepts and belong with their sole consumer.
 *
 * @module
 */
import { Context, Effect, Option, Predicate, Schema, type Layer } from "effect"
import { AiError, type LanguageModel, type Model as AiModel } from "effect/unstable/ai"
import type { Model } from "./agent.js"
import type { AuthAuthorizationMethod, AuthMethod } from "../runtime/provider.js"
import type { SessionId } from "./ids.js"

export const DriverFailureId = Schema.String.pipe(Schema.brand("DriverFailureId"))
export type DriverFailureId = typeof DriverFailureId.Type

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
  readonly reasoning?: string
  readonly maxTokens?: number
  readonly temperature?: number
  /** Stable conversation identity for providers that support cache routing. */
  readonly cacheKey?: string
  /**
   * The catalog's `Model.reasoning` for the resolved model. A driver sends no
   * reasoning effort to a model the catalog says does not reason; absent when
   * the catalog does not say.
   */
  readonly supportsReasoning?: boolean
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
 * `listModels`. An OAuth sign-in carries no token copy: the store is the
 * one source, read and written through `update`.
 */
export const ProviderAuthInfo = Schema.TaggedUnion({
  Api: { key: Schema.String },
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

/** Persist auth credentials — invoked by `ProviderAuth` into a model driver's
 *  auth handlers. */
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
  /** Upper bound of any delay, in milliseconds. */
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

// ── ModelDriverContribution — provider-shaped driver ──

/**
 * Registers a model provider as a driver. `id` doubles as the driver id, the
 * model returned by `resolveModel` provides an `effect/unstable/ai` LanguageModel,
 * `listModels` supplies the driver's own catalog, and `auth` wires the OAuth/API
 * key flow. The driver registry routes a `DriverRef({ _tag: "Model", id })`
 * to the matching contribution.
 */
export interface ModelDriverContribution {
  /** Driver id — matches the provider id segment in `provider/model` model names. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Resolve a model name to an Effect AI model. */
  readonly resolveModel: (
    modelName: string,
    authInfo?: ProviderAuthInfo,
    hints?: ProviderHints,
  ) => Effect.Effect<ProviderResolution, ProviderAuthError>
  /** The driver's own model catalog. Core concatenates every driver's list; it fetches nothing. */
  readonly listModels?: (
    authInfo?: ProviderAuthInfo,
  ) => Effect.Effect<ReadonlyArray<Model>, DriverError | ProviderAuthError>
  /** Auth configuration — OAuth + API key methods + handlers. */
  readonly auth?: ProviderAuthContribution
  /**
   * The environment variable the driver reads a credential from when nothing
   * is stored (e.g. `ANTHROPIC_API_KEY`). The auth listing reports a set one
   * as `source: "env"`, so a user with only that variable is not asked to
   * sign in.
   */
  readonly envCredential?: string
  /** Retry policy for this driver's transient failures; `DEFAULT_RETRY_POLICY` when absent. */
  readonly retry?: RetryPolicy
}
