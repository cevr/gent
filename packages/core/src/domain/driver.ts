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
import { Context, Duration, Effect, Option, Predicate, Schema, type Layer } from "effect"
import type { HttpClient } from "effect/http"
import {
  AiError,
  type DecisionModel,
  type LanguageModel,
  type Model as AiModel,
  type Response,
} from "effect/ai"
import {
  type CacheWriteByLifetime,
  type ImageCost,
  type ImageLimit,
  type ImagePartOptions,
  Model,
  type ModelPricing,
  type PromptOptions,
  ModelId,
  ProviderId,
  ReasoningEffort,
} from "./agent.js"
import { omitUndefined } from "./guards.js"
import { CredentialSlot, DEFAULT_CREDENTIAL_SLOT, type SessionId } from "./ids.js"
import type { ExtensionContext, ExtensionServiceError } from "./extension.js"
import type { Message } from "./message.js"
import type { Usage } from "./event.js"

export const DriverFailureId = Schema.String.pipe(Schema.brand("DriverFailureId"))
export type DriverFailureId = typeof DriverFailureId.Type

// ── Auth method wire types ──

/**
 * A credential order: slots a turn walks first to last, each named once. An
 * empty order is the RPC's way to clear one; a stored order adds a minimum
 * length of one.
 */
export const CredentialOrder = Schema.Array(CredentialSlot).check(
  Schema.makeFilter((slots) => new Set(slots).size === slots.length, {
    message: "credential slots must be distinct",
  }),
)

/**
 * The credential a model request used: the provider that owns the sign-in
 * and the slot. Labels only, never a secret or an account. `signedInAt` is
 * when the stored credential was signed in or replaced (a refresh keeps
 * it), in epoch milliseconds; absent for a credential from the environment
 * and one the auth store kept before the stamp.
 */
export const CredentialReceipt = Schema.Struct({
  provider: ProviderId,
  slot: CredentialSlot,
  signedInAt: Schema.optional(Schema.Finite),
})
export type CredentialReceipt = typeof CredentialReceipt.Type

/**
 * Whether two requests went out with one credential, so the cache one wrote
 * can serve the other: the same sign-in, and the same sign-in moment when
 * both receipts know it (a rename keeps it, a new sign-in on the slot does
 * not); else the same slot. A receipt with no stamp compares by slot alone.
 */
export const sameCredential = (left: CredentialReceipt, right: CredentialReceipt): boolean => {
  if (left.provider !== right.provider) return false
  if (Predicate.isNotUndefined(left.signedInAt) && Predicate.isNotUndefined(right.signedInAt))
    return left.signedInAt === right.signedInAt
  return left.slot === right.slot
}

/**
 * One provider-owned sign-in input. An API method asks after the key and
 * stores the answer beside it as
 * `metadata[key]`; an OAuth method receives it in `inputs`. When `env` names
 * a variable that is set, `/auth` does not
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

/** The answers to a sign-in's provider-owned prompts, by prompt key. */
export const AuthMetadata = Schema.Record(Schema.String, Schema.String)
export type AuthMetadata = typeof AuthMetadata.Type

/**
 * How a provider signs in: an API key or an OAuth login. Either may ask
 * provider-owned `prompts`, in order.
 */
export class AuthMethod extends Schema.Class<AuthMethod, { readonly brand: unique symbol }>(
  "AuthMethod",
)({
  type: Schema.Literals(["api", "oauth"]),
  label: Schema.String,
  /** Omitted methods keep legacy applicability to either credential target. */
  credentialTarget: Schema.optional(Schema.Literals(["default", "named"])),
  prompts: Schema.optional(Schema.Array(AuthPrompt)),
}) {}

/** Provider-owned applicability, shared by authorization and target pickers. */
export const authMethodAppliesTo = (
  method: AuthMethod,
  slot: CredentialSlot = DEFAULT_CREDENTIAL_SLOT,
): boolean => {
  if (Predicate.isUndefined(method.credentialTarget)) return true
  if (slot === DEFAULT_CREDENTIAL_SLOT) return method.credentialTarget === "default"
  return method.credentialTarget === "named"
}

export const AuthAuthorizationMethod = Schema.Literals(["auto", "code", "done"])
export type AuthAuthorizationMethod = typeof AuthAuthorizationMethod.Type

// ── Failure type ──

/** Failure raised when a driver lookup or dispatch fails. */
export class DriverError extends Schema.TaggedError<
  DriverError,
  { readonly brand: unique symbol }
>()("DriverError", {
  driver: DriverFailureId,
  reason: Schema.String,
}) {}

// ── Shapes shared by every model driver ──

/**
 * Why one credential cannot serve, where a driver proved it: the slot holds
 * none (`Unavailable`), the provider refused it or its refresh
 * (`Rejected`), or its account does not include the model
 * (`UnsupportedModel`). Only these move a turn to the next credential of its
 * order; a read, parse or persist fault carries none.
 */
export const CredentialFailureReason = Schema.Literals([
  "Unavailable",
  "Rejected",
  "UnsupportedModel",
])
export type CredentialFailureReason = typeof CredentialFailureReason.Type

export class ProviderAuthError extends Schema.TaggedError<
  ProviderAuthError,
  { readonly brand: unique symbol }
>()("ProviderAuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  credentialFailure: Schema.optional(CredentialFailureReason),
}) {}

/**
 * AiError metadata that carries a credential failure through a provider SDK.
 * The SDK keeps a reason's metadata but drops its cause, and it adds its own
 * text to the message. A driver attaches the failure here; the loop shows the
 * user the failure's own message, and reads its reason when one was proved.
 */
const CredentialFailureMetadata = Schema.Struct({
  gent: Schema.Struct({
    credentialFailure: Schema.String,
    reason: Schema.optional(CredentialFailureReason),
  }),
})

/** The AiError reason metadata that carries `error` to the loop. */
export const credentialFailureMetadata = (
  error: ProviderAuthError,
): typeof CredentialFailureMetadata.Type => ({
  gent: {
    credentialFailure: error.message,
    ...omitUndefined({ reason: error.credentialFailure }),
  },
})

/** The proved reason a model error's credential failed, if a driver attached one. */
// oxlint-disable-next-line effect/noUnknownParameters -- Model streams expose provider-specific error values.
export const credentialFailureReason = (error: unknown): Option.Option<CredentialFailureReason> => {
  if (Schema.is(ProviderAuthError)(error)) return Option.fromUndefinedOr(error.credentialFailure)
  if (!AiError.isAiError(error) || !Predicate.hasProperty(error.reason, "metadata")) {
    return Option.none()
  }
  return Schema.decodeUnknownOption(CredentialFailureMetadata)(error.reason.metadata).pipe(
    Option.flatMap((metadata) => Option.fromUndefinedOr(metadata.gent.reason)),
  )
}

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

/**
 * The effort an assistant run was sent at: a level, or `default` for a
 * request that named none to a model that reasons, which ran at the model's
 * own default (`StreamEnded.reasoningDefault`).
 */
export type RunEffort = ReasoningEffort | "default"

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
   * The turn the request belongs to: the same for every step and retry of
   * one turn, new for the next (the turn's message id). A provider that
   * routes a turn's requests to one backend keys its route by it.
   */
  readonly turnKey?: string
  /**
   * The request is a spawned child session's (`isSpawnedSession`) whose
   * agent keeps the child cache (`AgentDefinition.promptCache`). Such a child
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
   * messages, from the steps' receipts (`StreamEnded.reasoningLevel`, or
   * `default` by `StreamEnded.reasoningDefault`). None where no receipt says:
   * a step on another model, a forked branch.
   * A driver whose wire carries an effort change
   * inside the conversation rebuilds the changes from it, so the request's
   * earlier bytes stay the same. Absent on a request with no conversation
   * history to keep (the compaction summary).
   */
  readonly reasoningHistory?: ReadonlyArray<Option.Option<RunEffort>>
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
 * A token rotation a driver got for a login another program keeps (a
 * linked Claude Code directory), held in gent's credential store until
 * that program's store holds it. The refresh spent the program's refresh
 * token, so until then `rotation` is the only live token of the login.
 * `base` fingerprints the stored login the spend replaced: the program's
 * store is still where gent left it while it holds that login, and moved on
 * (a sign-in, its own refresh) once it holds another.
 */
export const PendingRotation = Schema.Struct({
  rotation: Schema.Struct({
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Finite,
  }),
  base: Schema.String,
})
export type PendingRotation = typeof PendingRotation.Type

/**
 * What the store keeps at a source's place once a held rotation's file did
 * not decode and its bytes were moved aside to `file`, which gent never
 * deletes. Those bytes may hold the only live token of the login whose
 * fingerprint is `base`, the login the driver found beside them, so that
 * login is never spent while the source still holds it.
 */
export const QuarantinedRotation = Schema.Struct({
  quarantined: Schema.Struct({ base: Schema.String, file: Schema.String }),
})
export type QuarantinedRotation = typeof QuarantinedRotation.Type

/** What the store holds for a source: a pending rotation, or the record of one moved aside. */
export const HeldRotation = Schema.Union([PendingRotation, QuarantinedRotation])
export type HeldRotation = typeof HeldRotation.Type

/**
 * A held rotation's file that does not decode, at the absolute path `file`.
 * It carries no decode issue: one can quote the file's bytes, which may hold
 * a live token.
 */
export class HeldRotationUndecodable extends Schema.TaggedError<
  HeldRotationUndecodable,
  { readonly brand: unique symbol }
>()("HeldRotationUndecodable", {
  file: Schema.String,
}) {
  override get message(): string {
    return `The held token rotation at ${this.file} does not decode`
  }
}

/** The pending rotation of one source, read and written under the store's lock. */
export interface SourceRotation {
  /**
   * What the store holds for the source; none once it landed. A file that
   * does not decode fails typed, naming the file.
   */
  readonly read: Effect.Effect<
    Option.Option<HeldRotation>,
    ProviderAuthError | HeldRotationUndecodable
  >
  /** Hold `next`, or, with none, forget what the store holds for the source. */
  readonly write: (next: Option.Option<PendingRotation>) => Effect.Effect<void, ProviderAuthError>
  /**
   * Move the source's file that does not decode aside, byte for byte, to a
   * sibling it returns, and keep the record of it (`QuarantinedRotation`)
   * with `base` at its place, in one step; with no base, keep nothing there.
   * A move that fails leaves the file where it is; one that is retried
   * reuses the sibling an earlier attempt made, so the bytes keep one other name.
   */
  readonly moveAside: (base: Option.Option<string>) => Effect.Effect<string, ProviderAuthError>
}

/**
 * Run `use` with the pending rotation of `source` (a key the driver derives
 * from the login's place, never from a label), under the same lock as every
 * write of the provider's credentials: in this process and, on a host with a
 * lock file, in every gent process over the store. Two refreshes of one
 * source, in two profiles or two processes, never interleave. A lock another
 * holder keeps for the whole wait fails `CredentialStoreBusy`: `use` never
 * ran, and the store is as it was.
 */
export type LockSourceRotation = (
  source: string,
) => <A, E>(
  use: (held: SourceRotation) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | ProviderAuthError | CredentialStoreBusy>

/**
 * The credential store's lock stayed held by another holder for the whole
 * wait (another gent process mid-refresh, say): nothing ran, nothing changed,
 * and a later attempt may pass.
 */
export class CredentialStoreBusy extends Schema.TaggedError<
  CredentialStoreBusy,
  { readonly brand: unique symbol }
>()("CredentialStoreBusy", {
  provider: Schema.String,
}) {
  override get message(): string {
    return `gent's credential store is busy: its lock for "${this.provider}" stayed held by another holder for the whole wait`
  }
}

const LockSourceRotation = Schema.declare<LockSourceRotation>(
  (value): value is LockSourceRotation => Predicate.isFunction(value),
)

/**
 * The stored credential a driver receives in `resolveModel` and
 * `listModels`. An API key carries the answers to its method's prompts
 * (`metadata`, absent for a key stored without any). An OAuth sign-in carries
 * no token copy: the store is the one source, read and written through
 * `update`. Its `signedInAt` is the stamp of the sign-in the label holds now
 * (absent for one stored before stamps): a cache a driver keeps per label
 * serves only that sign-in, so a label renamed or signed in again is never
 * answered by the account it held before. Its `metadata` is what its sign-in
 * stored beside the tokens (`PersistAuth`), as an API key's answers are: a
 * refresh through `update` and a rename keep it, and no `/auth` listing
 * shows it. `lockSourceRotation` reaches the rotations a driver holds for
 * logins other programs keep (`PendingRotation`), keyed by the login's
 * place, so a rename or a second sign-in of the label meets the same one;
 * the store gives it to every OAuth sign-in.
 */
export const ProviderAuthInfo = Schema.TaggedUnion({
  Api: {
    key: Schema.String,
    metadata: Schema.optional(AuthMetadata),
    slot: Schema.optional(CredentialSlot),
  },
  Oauth: {
    update: UpdateStoredOAuth,
    slot: Schema.optional(CredentialSlot),
    signedInAt: Schema.optional(Schema.Finite),
    metadata: Schema.optional(AuthMetadata),
    lockSourceRotation: Schema.optional(LockSourceRotation),
  },
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
 *  to a model driver's auth handlers. An OAuth sign-in may store its
 *  `metadata` beside the tokens; the driver reads it back on
 *  `ProviderAuthInfo.Oauth`. */
export type PersistAuth = (
  auth:
    | { readonly type: "api"; readonly key: string }
    | {
        readonly type: "oauth"
        readonly access: string
        readonly refresh: string
        readonly expires: number
        readonly accountId?: string
        readonly metadata?: AuthMetadata
      },
  /** Bounded owned-cell publication, no I/O or reentrant auth access. */
  onPersisted?: Effect.Effect<void, never, never>,
) => Effect.Effect<void, ProviderAuthError>

interface ProviderAuthorizeContext {
  readonly sessionId: SessionId
  readonly methodIndex: number
  readonly authorizationId: string
  readonly persist: PersistAuth
  readonly slot?: CredentialSlot
  readonly inputs?: AuthMetadata
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
 * A failure can name when a retry succeeds (`retryAt`); that time replaces
 * the backoff, and a time past `maxDelay` ends the retries at once.
 */
export interface RetryPolicy {
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelay: number
  /** Upper bound of any delay, in milliseconds. A failure that resets later than this from now is not retried. */
  readonly maxDelay: number
  /** Multiplier applied to the delay after each attempt. */
  readonly backoffFactor: number
  /** Attempts in total, the first call included. */
  readonly maxAttempts: number
  /** Wire shape of a mid-stream error event this driver treats as transient. */
  readonly transientStreamEvent: Schema.Top
  /** True when a failed request was refused as longer than the model accepts. */
  readonly contextOverflow: (cause: unknown) => boolean
  /**
   * When a retry of this failure can succeed, in epoch milliseconds, read
   * from the provider's own fields by schema (a header, the error body),
   * never from message text; none when the failure names no time.
   * `DEFAULT_RETRY_POLICY` reads the typed retry-after (`retryAfterAt`); a
   * driver adds the reset fields of a rate-limited request
   * (`rateLimitResponse`), and the latest time it knows wins, so a generic
   * retry-after never shortens a usage limit's reset. A usage limit that resets in
   * hours names a time past `maxDelay`: the step fails at once, and the
   * turn's `ErrorOccurred.retryAt` and `TurnAfterInput.retryAt` carry it.
   */
  readonly retryAt: (cause: unknown, nowMs: number) => Option.Option<number>
}

/** The provider's typed retry-after, counted from `nowMs`; the default `RetryPolicy.retryAt`. */
export const retryAfterAt = (cause: unknown, nowMs: number): Option.Option<number> => {
  if (!AiError.isAiError(cause)) return Option.none()
  return Option.map(
    Option.fromUndefinedOr(cause.retryAfter),
    (retryAfter) => nowMs + Duration.toMillis(retryAfter),
  )
}

/**
 * The HTTP response a rate-limited request kept: its headers (lower-case
 * names, as the HTTP client gives them) and its raw body. A driver decodes
 * its reset fields from these.
 */
export interface FailureResponse {
  readonly headers: (typeof AiError.HttpResponseDetails.Type)["headers"]
  readonly body: Option.Option<string>
}

/**
 * The response of a request the provider refused for a rate or usage limit,
 * when the failure kept one. Any other failure has none: a refused request
 * can carry the same limit headers, and they say nothing about its retry.
 */
export const rateLimitResponse = (cause: unknown): Option.Option<FailureResponse> => {
  if (!AiError.isAiError(cause) || cause.reason._tag !== "RateLimitError") return Option.none()
  const http = Option.fromUndefinedOr(cause.reason.http)
  return Option.map(http, (context) => ({
    headers: context.response?.headers ?? {},
    body: Option.fromUndefinedOr(context.body),
  }))
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

// ── Provider report ──

/**
 * One quota window as the provider reported it on a response. `window` is the
 * provider's own name for it (Anthropic's `5h`, `7d`), `utilization` the
 * fraction used (above 1 when usage ran past the window's cap), `resetAt` when
 * it is full again (epoch ms), and `rejected` that the provider refuses
 * requests on this window until then. `model` names the one model the window
 * meters (OpenCode Go limits each model on its own); a window without one
 * meters every request on the account.
 */
export const QuotaReading = Schema.Struct({
  window: Schema.String,
  utilization: Schema.Finite,
  resetAt: Schema.Finite,
  rejected: Schema.Boolean,
  model: Schema.optionalKey(ModelId),
})
export type QuotaReading = typeof QuotaReading.Type

/**
 * One window of a plan that limits a model by what its requests cost, not by
 * a server's report: at most `usd` of list price in any trailing `window`
 * (`5h`, `7d`, `31d`). Gent meters each account's own spend on the model
 * against it and reads the window as a quota window of that model
 * (`ModelDriverContribution.spendLimits`).
 */
export const SpendLimit = Schema.Struct({
  window: Schema.String,
  usd: Schema.Finite,
})
export type SpendLimit = typeof SpendLimit.Type

/**
 * What a driver that reads the wire reports about one step's request. The
 * loop provides this service to each step's model stream and reads it when
 * the step settles. `stopReason` is the provider's own word for why the
 * stream stopped: Effect AI maps that word to a `FinishReason` and keeps no
 * copy of it, and a word its map lacks becomes `"unknown"`, as Anthropic's
 * `model_context_window_exceeded` does (`@effect/ai-anthropic`
 * `internal/utilities.ts`). `quota` is the account's quota windows as the
 * response's headers name them: the loop records them against the credential
 * the request went out on.
 */
export class ProviderReport extends Context.Service<
  ProviderReport,
  {
    readonly stopReason: (reason: string) => Effect.Effect<void>
    readonly quota: (readings: ReadonlyArray<QuotaReading>) => Effect.Effect<void>
    readonly cacheWarmer: (warmer: CacheWarmer) => Effect.Effect<void>
  }
>()("@gent/core/src/domain/driver/ProviderReport") {}

/**
 * How a driver keeps the step's prompt cache warm while the step's tools run.
 * `sentAtMillis` is when the step's request went out; `resend` sends the same
 * request again for no output (a cache read refreshes the entry's lifetime)
 * and answers with its usage and its cache writes by lifetime (a read past
 * the lifetime writes the prefix again), none when the request failed (the
 * driver logs why). The loop calls it only while the step's tools run and the
 * cache would lapse before they finish, and listens to it as to the step's
 * stream: a quota the read names reaches the step's account.
 */
export interface CacheWarmer {
  readonly sentAtMillis: number
  readonly resend: Effect.Effect<
    Option.Option<Usage & { readonly cacheWritesByLifetime: ReadonlyArray<CacheWriteByLifetime> }>,
    never,
    ProviderReport
  >
}

/** Nothing listens outside a loop step. */
const reportToLoop = (
  report: (listener: ProviderReport["Service"]) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.serviceOption(ProviderReport).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: report,
      }),
    ),
  )

/** A driver reports the stream's raw stop reason. */
export const reportProviderStopReason = (reason: string): Effect.Effect<void> =>
  reportToLoop((listener) => listener.stopReason(reason))

/** A driver reports how to keep the step's cache warm (`CacheWarmer`). */
export const reportProviderCacheWarmer = (warmer: CacheWarmer): Effect.Effect<void> =>
  reportToLoop((listener) => listener.cacheWarmer(warmer))

/** A driver reports the quota windows a response named; none named reports nothing. */
export const reportProviderQuota = (readings: ReadonlyArray<QuotaReading>): Effect.Effect<void> => {
  if (readings.length === 0) return Effect.void
  return reportToLoop((listener) => listener.quota(readings))
}

// ── Account lanes ──

/** One quota window of one account, as `accounts.lanes` reports it. */
export const LaneWindow = Schema.Struct({
  window: Schema.String,
  /** The one model the window meters; absent when it meters the whole account. */
  model: Schema.optionalKey(ModelId),
  /** The fraction used at the last reading; 0 once its reset passed. */
  utilization: Schema.Finite,
  resetAt: Schema.Finite,
  readAt: Schema.Finite,
  rejected: Schema.Boolean,
  /** Fuel per percentage point of this window, its own, else the provider's over every account. */
  fuelPerPct: Schema.optionalKey(Schema.Finite),
  /** The rate's relative uncertainty from the 1% steps (lanes r3): ±0.5 / the points its segments moved. */
  band: Schema.optionalKey(Schema.Finite),
  /** The segments the rate reads. */
  samples: Schema.Int,
  /** The share of the window's move no fuel of gent's explains: spend outside gent. */
  outsideShare: Schema.Finite,
  /** The runs the window can carry until its reset; none without a rate. */
  sustainable: Schema.optionalKey(Schema.Finite),
  /**
   * Each model's fuel per percentage point of this account window: its own
   * mix's rate at the models' quota weights, over the model's weight. Absent
   * on a model's window, and on a window with no rate of its own.
   */
  models: Schema.optionalKey(
    Schema.Array(Schema.Struct({ model: ModelId, fuelPerPct: Schema.Finite })),
  ),
})

/** One account of a provider. */
export const LaneAccount = Schema.Struct({
  slot: CredentialSlot,
  windows: Schema.Array(LaneWindow),
  /** Held by a refusal or a rejected account-wide window: it carries no run now. */
  held: Schema.Boolean,
  /**
   * The fewest runs any of its account-wide windows can carry; none when one
   * has no rate or none was read. A model's window is listed but not counted:
   * it bounds only that model's runs, and the report serves every model.
   */
  sustainable: Schema.optionalKey(Schema.Finite),
})

/**
 * One model's quota weight on a provider: the points one fuel of it moves,
 * relative to the provider's other models, scaled so the fitted fuel counts
 * at its list price in all. A window's cost of the model is its
 * `LaneWindow.models` entry: its mix's rate at the weights, over the weight.
 */
export const LaneModel = Schema.Struct({
  model: ModelId,
  /** 1 until fitted: the model costs its list price. */
  weight: Schema.Finite,
  /** Whether the weight was fitted: its segments span a day, and they alone price it within 10%. */
  fitted: Schema.Boolean,
  /** The hours between the first and the last segment its fuel fell in. */
  spanHours: Schema.Finite,
})

/**
 * A project's held lanes on a sign-in (`providers.<owner>.authHold`): runs
 * of the project up to `lanes` are admitted whatever the pace.
 */
const LaneHold = Schema.Struct({
  /** The project, as `ConfigService.project` names it. */
  project: Schema.String,
  lanes: Schema.Int,
  /** The project's turns and admitted starts on the sign-in now, any model. */
  used: Schema.Int,
})

/** One provider's lanes. */
export const ProviderLanes = Schema.Struct({
  provider: Schema.String,
  /** The accounts an unpinned run spends from: the pool, else the order's first. */
  scope: Schema.Array(CredentialSlot),
  accounts: Schema.Array(LaneAccount),
  /**
   * Whole runs at the scope's rolling weekly pace, capped by weekly and
   * short-window room. Account sustainable values still describe placement
   * now. Without weekly readings, sum the account minima as before. None
   * until the scope has the readings and rates needed for its pace.
   */
  capacity: Schema.optionalKey(Schema.Int),
  /**
   * The runs that hold a lane on the scope's accounts now: turns open on
   * them, and starts admitted whose turn has not opened yet. Each counts at
   * its model's share of a mean run (its fuel per hour at its quota weight),
   * so a cheap model's run holds part of a lane.
   */
  load: Schema.Finite,
  /**
   * The fuel one run burns in an hour: measured over the provider's ended
   * lanes once they ran a lane-hour, else the bridge prior (3.4 M).
   */
  fuelPerHour: Schema.Finite,
  /** The lane-hours `fuelPerHour` was measured over; under 1 it is the prior. */
  laneHours: Schema.Finite,
  /** Each model whose fuel fell in a kept segment of an account window, with its quota weight. */
  models: Schema.Array(LaneModel),
  /** The projects the owner holds lanes for on this sign-in, by project. */
  holds: Schema.Array(LaneHold),
})

/** `accounts.lanes`: every provider gent read a quota window of. Labels and numbers only. */
export const LaneReport = Schema.Struct({ providers: Schema.Array(ProviderLanes) })
export type LaneReport = typeof LaneReport.Type
export type LaneAccount = typeof LaneAccount.Type
export type LaneWindow = typeof LaneWindow.Type
export type LaneModel = typeof LaneModel.Type

/** A lane count as it reads: to one decimal place, so a sum of run shares lands on whole runs. */
export const roundLanes = (lanes: number) => Math.round(lanes * 10) / 10
export type ProviderLanes = typeof ProviderLanes.Type

/**
 * A run refused a lane at admission: the provider's accounts carry no more
 * runs now. `Busy`: every lane is held by a run; one frees when a run ends.
 * `Spent`: the quota windows carry no run until one resets (or a refusal's
 * hold ends). `retryAt` is the next useful admission check (epoch ms), never
 * a promise of a lane.
 */
export class LaneUnavailable extends Schema.TaggedError<
  LaneUnavailable,
  { readonly brand: unique symbol }
>()("LaneUnavailable", {
  message: Schema.String,
  provider: Schema.String,
  reason: Schema.Literals(["Busy", "Spent"]),
  capacity: Schema.Int,
  load: Schema.Finite,
  retryAt: Schema.Finite,
}) {}

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
  retryAt: retryAfterAt,
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
  /** Whether `modalities.input` lists `image`; absent when the entry names no input modalities. */
  imageInput: Schema.optional(Schema.Boolean),
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

/** What an API class decides about a catalog model it speaks (`modelFromCatalog`). */
export type CatalogPlan = Pick<
  ApiClassContribution,
  "efforts" | "imageLimit" | "imageCost" | "imagePartOptions" | "hostContextUpdateOptions"
>

/**
 * A catalog model as gent's `Model`, under `providerId` (a driver id, which
 * may differ from the catalog provider's). A decision model is a classifier.
 * `apiClass` is the class that speaks it: its requests name the class's
 * effort levels (`Model.efforts`; by default the catalog's effort list),
 * carry at most the class's tool images (`Model.imageLimit`), and count and
 * send each image as the class does (`Model.imageCost`,
 * `Model.imagePartOptions`), and mark a host context update as the class's
 * driver reads it (`Model.hostContextUpdateOptions`).
 */
export const modelFromCatalog = (
  providerId: string,
  entry: CatalogModel,
  apiClass: CatalogPlan = {},
): Model => {
  const levels = (apiClass.efforts ?? acceptedEfforts)(entry)
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
      imageInput: entry.imageInput,
      imageLimit: apiClass.imageLimit,
      imageCost: apiClass.imageCost?.(entry),
      imagePartOptions: apiClass.imagePartOptions,
      hostContextUpdateOptions: apiClass.hostContextUpdateOptions,
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
  /**
   * The tool images one request of this class may carry, when its servers
   * take fewer than the default bound (`Model.imageLimit`).
   */
  readonly imageLimit?: ImageLimit
  /**
   * What one tool image costs `entry` (`Model.imageCost`). Absent: the
   * highest of the known costs.
   */
  readonly imageCost?: (entry: CatalogModel) => ImageCost
  /**
   * The provider options each image part of this class's requests carries
   * (`Model.imagePartOptions`): the detail its `imageCost` counts at.
   */
  readonly imagePartOptions?: ImagePartOptions
  /**
   * The provider options the user message that carries a later system
   * message adds in this class's requests (`Model.hostContextUpdateOptions`):
   * the mark the class's driver tells it from the user's own text by.
   */
  readonly hostContextUpdateOptions?: PromptOptions
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
   * The spend windows a plan sets on one model (OpenCode Go), none for a
   * model it does not limit. Gent counts each step's and summary's price on
   * the account against them, so the account's lanes and placement read the
   * model's windows as no response names them. Spend past a limit that the
   * plan bills as extra usage counts as past the limit: it is never quota.
   */
  readonly spendLimits?: (modelName: string) => ReadonlyArray<SpendLimit>
  /**
   * The price one request of `modelName` bills at, from the price the
   * catalog lists: a plan that prices a model by the request's input tokens
   * or by the hour it ran in (OpenCode Go) bills above the listed price.
   * Absent, every request bills at the listed price.
   */
  readonly requestPricing?: (
    modelName: string,
    listed: ModelPricing,
    request: { readonly inputTokens: number; readonly at: number },
  ) => ModelPricing
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
  /**
   * Whether the request `hints` describe carries its effort inside the
   * conversation: where `hints.reasoning` differs from the levels of the
   * earlier runs (`hints.reasoningHistory`), the request sends the change as
   * an effort marker or a configuration update and keeps the bytes the
   * previous request (the last run's level over the runs before it) wrote
   * to the cache: the same top-level effort and the same changes before the
   * reply. False where the change would go at the top of the request (it
   * rewrites the cache), or this history cannot carry it (a change that
   * turns thinking on or off, or one after a run at a provider default the
   * wire did not name). Core asks it before `/effort auto`
   * changes the level on a warm cache; a change it does not carry holds the
   * level. Absent: no change is carried. `catalog` is the driver's view, as
   * `resolveModel` gets it; a resolver with no catalog passes none.
   */
  readonly carriesEffort?: (
    modelName: string,
    hints: ProviderHints,
    catalog?: ModelCatalogView,
  ) => boolean
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
  /**
   * On `/effort auto`, where the same router serves the effort router: its
   * choices, to pick in the same call (`ModelRouteDecision.effort`).
   */
  readonly effort?: ModelEffortRouteInput
}

/**
 * The effort router's part of a model route: its choices and, aligned with
 * them, a model a choice's level runs on (none: no choice of the model route
 * takes that level from this history).
 */
interface ModelEffortRouteInput {
  readonly model: VirtualModel
  readonly candidates: ReadonlyArray<Option.Option<Model>>
}

/** A choice a router picked, and why, in a few words. */
export interface ModelRouteChoice {
  readonly choice: number
  readonly reason: string
}

/**
 * The choice a router picked, and why. Where the input carried the effort
 * router, `effort` is its pick; absent, core asks the effort router alone.
 */
export interface ModelRouteDecision extends ModelRouteChoice {
  readonly effort?: ModelRouteChoice
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
  /**
   * The effort router `/effort auto` runs (`Session.reasoningAuto`): every
   * choice sets an effort and names no model. Not a model id: it is not
   * listed or selectable. Core routes it at a user turn's first step, after
   * a model route, with each choice's candidate the turn's model (none for a
   * level the model does not take), and records the pick as a `ModelRouted`
   * with `effortOnly`. A spawned child is never routed. On a warm cache a
   * choice is a candidate only where its level is the one the cache was
   * written at or the driver carries the change
   * (`ModelDriverContribution.carriesEffort`); with no other candidate the
   * level holds and `route` is not asked. Where the session runs on one of
   * this router's virtual models, the model route's input carries the
   * effort router too (`ModelRouteInput.effort`), so one call picks both.
   * The first registered router with one serves it.
   */
  readonly effort?: VirtualModel
  readonly route: (
    input: ModelRouteInput,
  ) => Effect.Effect<ModelRouteDecision, ExtensionServiceError, ExtensionContext>
}
