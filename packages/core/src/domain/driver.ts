/**
 * Model driver primitives. A `ModelDriverContribution` wraps an LLM provider:
 * auth, `listModels`, and `resolveModel` returning a model that provides an
 * `effect/unstable/ai` `LanguageModel`. The gent providers
 * (anthropic/openai/google/mistral) register one each.
 *
 * An agent may name a driver with `driver: DriverRef`; otherwise the loop
 * derives the driver from the provider segment of its model id.
 *
 * The auth, hint, and resolution shapes live here too: they are
 * model-driver-only concepts and belong with their sole consumer.
 *
 * @module
 */
import { Option, Predicate, Schema, type Effect, type Layer } from "effect"
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
 * How the loop retries a transient failure from this driver. A typed
 * `AiError` decides by its own `isRetryable`; a raw error event the stream
 * carried is transient when it matches `transientStreamEvent`. The loop only
 * re-runs the step; nothing here is inferred from message text.
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
}

/** Bounded backoff with no transient stream events; drivers spread and refine it. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  initialDelay: 2000,
  maxDelay: 30000,
  backoffFactor: 2,
  maxAttempts: 3,
  transientStreamEvent: Schema.Never,
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
