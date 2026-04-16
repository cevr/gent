/**
 * Driver primitives — unified registration for both model providers and
 * external turn executors.
 *
 * Codex's review of the C9 plan flagged that collapsing both into a single
 * `TurnDriver` interface loses provider-shaped capabilities (auth + listModels
 * + resolveModel). So drivers split by **capability** under one registry:
 *
 *   - `ModelDriverContribution`     — wraps an LLM provider (auth, listModels,
 *                                     resolveModel returning a Layer that
 *                                     produces an `effect/unstable/ai`
 *                                     `LanguageModel`). Five gent providers
 *                                     (anthropic/openai/google/mistral/bedrock)
 *                                     register one each.
 *   - `ExternalDriverContribution`  — wraps a `TurnExecutor` that streams
 *                                     `TurnEvent`s for fully external loops
 *                                     (ACP agents: claude-code/opencode/gemini-cli).
 *
 * Agents reference a driver by `driver: DriverRef`; the agent loop dispatches
 * through `DriverRegistry` instead of distinct `getProvider`/`getTurnExecutor`
 * paths. This replaces both `ProviderContribution` and
 * `TurnExecutorContribution` with a single capability-shaped union, dispatched
 * in one place — `composability-not-flags`.
 *
 * The auth/hint/resolution shapes that lived in `provider-contribution.ts`
 * move here too: they are model-driver-only concepts and belong with their
 * sole consumer.
 *
 * @module
 */
import { Data, type Effect, type Layer } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { AuthAuthorizationMethod, AuthMethod } from "./auth-method.js"
import type { TurnExecutor } from "./turn-executor.js"

// ── Driver reference re-export ──
//
// The canonical `DriverRef` schema lives on `AgentDefinition` (so it survives
// JSON roundtrips through `Schema.Class`). Re-exported here for callers that
// reach through the driver primitive.
export { DriverRef, ModelDriverRef, ExternalDriverRef } from "./agent.js"

// ── Failure type ──

/** Failure raised when a driver lookup or dispatch fails. */
export class DriverError extends Data.TaggedError("@gent/core/src/domain/driver/DriverError")<{
  readonly kind: "model" | "external"
  readonly id: string
  readonly reason: string
}> {}

// ── Shared types lifted from provider-contribution.ts ──

/** Resolution returned by a model driver's `resolveModel`. The Layer must be
 *  fully self-contained — auth, tool naming, cache control all baked in. */
export interface ProviderResolution {
  readonly layer: Layer.Layer<LanguageModel.LanguageModel>
}

/** Hints passed from the agent loop into `resolveModel`. Drivers bake these
 *  into their provider Config layer (e.g. `AnthropicLanguageModel.Config.max_tokens`). */
export interface ProviderHints {
  readonly reasoning?: string
  readonly maxTokens?: number
  readonly temperature?: number
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
  }) => Effect.Effect<void>
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
) => Effect.Effect<void>

export interface ProviderAuthorizeContext {
  readonly sessionId: string
  readonly methodIndex: number
  readonly authorizationId: string
  readonly persist: PersistAuth
}

export interface ProviderCallbackContext extends ProviderAuthorizeContext {
  readonly code?: string
}

export interface ProviderAuthorizationResult {
  readonly url: string
  readonly method: AuthAuthorizationMethod
  readonly instructions?: string
}

export interface ProviderAuthContribution {
  readonly methods: ReadonlyArray<AuthMethod>
  readonly authorize?: (
    ctx: ProviderAuthorizeContext,
  ) => Effect.Effect<ProviderAuthorizationResult | undefined>
  readonly callback?: (ctx: ProviderCallbackContext) => Effect.Effect<void>
}

// ── ModelDriverContribution — provider-shaped driver ──

/**
 * Registers a model provider as a driver. Same capability surface as the
 * pre-C9 `ProviderContribution` — `id` doubles as the driver id, the layer
 * returned by `resolveModel` produces an `effect/unstable/ai` LanguageModel,
 * `listModels` filters/extends the catalog, and `auth` wires the OAuth/API
 * key flow. The driver registry routes a `DriverRef({ _tag: "model", id })`
 * to the matching contribution.
 */
export interface ModelDriverContribution {
  /** Driver id — matches the provider id segment in `provider/model` model names. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Resolve a model name to a layer that produces a LanguageModel. */
  readonly resolveModel: (
    modelName: string,
    authInfo?: ProviderAuthInfo,
    hints?: ProviderHints,
  ) => ProviderResolution
  /** Filter or extend the model catalog. */
  readonly listModels?: (
    baseCatalog: ReadonlyArray<unknown>,
    authInfo?: ProviderAuthInfo,
  ) => ReadonlyArray<unknown>
  /** Auth configuration — OAuth + API key methods + handlers. */
  readonly auth?: ProviderAuthContribution
}

// ── ExternalDriverContribution — turn-executor-shaped driver ──

/**
 * Registers an external execution loop as a driver. The wrapped
 * `TurnExecutor` streams `TurnEvent`s; the agent loop collects them into an
 * assistant draft. The driver registry routes a
 * `DriverRef({ _tag: "external", id })` to the matching contribution.
 */
export interface ExternalDriverContribution {
  /** Driver id — referenced by `agent.driver: DriverRef({ _tag: "external", id })`. */
  readonly id: string
  /** The turn executor implementation. */
  readonly executor: TurnExecutor
}

export type AnyDriverContribution = ModelDriverContribution | ExternalDriverContribution
