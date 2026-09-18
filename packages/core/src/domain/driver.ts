/**
 * Driver primitives — unified registration for both model providers and
 * external turn executors.
 *
 * One `TurnDriver` interface for both would lose the provider-shaped
 * capabilities (auth + listModels + resolveModel), so drivers split by
 * **capability** under one registry:
 *
 *   - `ModelDriverContribution`     — wraps an LLM provider (auth, listModels,
 *                                     resolveModel returning a Layer that
 *                                     produces an `effect/unstable/ai`
 *                                     `LanguageModel`). Four gent providers
 *                                     (anthropic/openai/google/mistral)
 *                                     register one each.
 *   - `ExternalDriverContribution`  — wraps a `TurnExecutor` that streams
 *                                     Effect AI response parts for fully external loops
 *                                     (ACP agents: claude-code/opencode/gemini-cli).
 *
 * Agents reference a driver by `driver: DriverRef`; the agent loop dispatches
 * through `DriverRegistry`, so both kinds of backend reach a turn through one
 * capability-shaped union resolved in one place — `composability-not-flags`.
 *
 * The auth, hint, and resolution shapes live here too: they are
 * model-driver-only concepts and belong with their sole consumer.
 *
 * @module
 */
import { Context, Schema, type Effect, type Layer, type Option, type Stream } from "effect"
import type { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import type * as Response from "effect/unstable/ai/Response"
import type { AgentDefinition, Model } from "./agent.js"
import type { AuthAuthorizationMethod, AuthMethod } from "./auth.js"
import type { ToolCapability } from "./capability/tool.js"
import type { ExtensionHostContext } from "./extension-services.js"
import type { BranchId, SessionId } from "./ids.js"
import type { InteractionPendingError } from "./interaction-request.js"
import type { Message } from "./message.js"

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

/** Auth info passed to `resolveModel` — mirrors `AuthStore` entries. */
export interface ProviderAuthInfo {
  readonly type: string
  readonly key?: string
  /** OAuth access token. */
  readonly access?: string
  /** OAuth refresh token. */
  readonly refresh?: string
  /** OAuth expiry timestamp (ms). */
  readonly expires?: number
  /** OAuth account ID. */
  readonly accountId?: string
  /** Persist updated auth back to the store (token refresh path). */
  readonly persist?: (updated: {
    access: string
    refresh: string
    expires: number
    accountId?: string
  }) => Effect.Effect<void, ProviderAuthError>
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
 * `listModels` filters/extends the catalog, and `auth` wires the OAuth/API
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
  /** Filter or extend the model catalog. */
  readonly listModels?: (
    baseCatalog: ReadonlyArray<Model>,
    authInfo?: ProviderAuthInfo,
  ) => ReadonlyArray<Model>
  /** Auth configuration — OAuth + API key methods + handlers. */
  readonly auth?: ProviderAuthContribution
  /** Retry policy for this driver's transient failures; `DEFAULT_RETRY_POLICY` when absent. */
  readonly retry?: RetryPolicy
}

// ── External-driver shapes ──
//
// External drivers stream upstream Effect AI response parts directly. Gent's
// durable events remain receipts derived at the runtime edge.
export type TurnStreamPart = Response.AnyPart

/** Failure raised by an external driver while streaming a turn. */
export class TurnError extends Schema.TaggedError<TurnError>()("TurnError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** What an external driver receives per turn. */
export interface TurnContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agent: AgentDefinition
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<ToolCapability>
  readonly systemPrompt: string
  readonly cwd: string
  readonly abortSignal: AbortSignal
  readonly hostCtx: ExtensionHostContext
}

interface ExternalToolRunnerService {
  readonly runTool: (
    toolName: string,
    args: Schema.Schema.Type<typeof Schema.Unknown>,
  ) => Effect.Effect<unknown, InteractionPendingError | TurnError>
}

export class ExternalToolRunner extends Context.Service<
  ExternalToolRunner,
  ExternalToolRunnerService
>()("@gent/core/src/domain/driver/ExternalToolRunner") {}

/** Executor interface implemented by external drivers (ACP agents, etc.).
 *
 *  Cancellation is per-turn via `ctx.abortSignal` inside `executeTurn` — each
 *  driver wires the signal to its own cancel mechanism (ACP `conn.cancel`,
 *  SDK `q.interrupt`). A driver-wide `cancel(sessionId)` hook would only see
 *  the outer session string, not the full `(sessionId, branchId, driverId)`
 *  cache key, so it cannot target a specific cached session correctly.
 *  Counsel  — drop the dead optional rather than keep it as a no-op stub. */
export interface TurnExecutor {
  readonly executeTurn: (
    ctx: TurnContext,
  ) => Stream.Stream<TurnStreamPart, TurnError | InteractionPendingError, ExternalToolRunner>
}

// ── ExternalDriverContribution — turn-executor-shaped driver ──

/**
 * Registers an external execution loop as a driver. The wrapped
 * `TurnExecutor` streams Effect AI response parts; the agent loop collects them into an
 * assistant draft. The driver registry routes a
 * `DriverRef({ _tag: "External", id })` to the matching contribution.
 */
export interface ExternalDriverContribution {
  /** Driver id — referenced by `agent.driver: DriverRef({ _tag: "External", id })`. */
  readonly id: string
  /** The turn executor implementation. */
  readonly executor: TurnExecutor
  /**
   * Hook called by the runtime when a config change makes any cached
   * external session for this driver stale (e.g. `driver.set` /
   * `driver.clear` swaps an agent's routing). Implementations should tear
   * down every cached session keyed under this driver id. External drivers
   * are the only contributors to this primitive, and an absent `invalidate`
   * hides cache-staleness bugs. Stateless drivers supply `Effect.void`
   * explicitly so reviewers see the intent.
   */
  readonly invalidate: Effect.Effect<void>
}
