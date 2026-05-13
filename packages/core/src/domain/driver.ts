/**
 * Driver primitives — unified registration for both model providers and
 * external turn executors.
 *
 * Codex's review of the  plan flagged that collapsing both into a single
 * `TurnDriver` interface loses provider-shaped capabilities (auth + listModels
 * + resolveModel). So drivers split by **capability** under one registry:
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
import { Context, Schema, type Effect, type Layer, type Stream } from "effect"
import type { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import type * as Response from "effect/unstable/ai/Response"
import type { AgentDefinition } from "./agent.js"
import type { AuthAuthorizationMethod, AuthMethod } from "./auth.js"
import type { ToolCapability } from "./capability/tool.js"
import type { ExtensionHostContext } from "./extension-host-context.js"
import type { BranchId, SessionId } from "./ids.js"
import type { Message } from "./message.js"
import type { Model } from "./model.js"
import type { ProviderError } from "./provider-error.js"

export const DriverFailureId = Schema.String.pipe(Schema.brand("DriverFailureId"))
export type DriverFailureId = typeof DriverFailureId.Type

// Note: TurnExecutor is defined below alongside the driver primitives — no
// external import of `TurnExecutor` is needed.

// ── Driver reference re-export ──
//
// The canonical `DriverRef` schema lives on `AgentDefinition` (so it survives
// JSON roundtrips through `Schema.Class`). Re-exported here for callers that
// reach through the driver primitive.
export { DriverRef, ModelDriverRef, ExternalDriverRef } from "./agent.js"

// ── Failure type ──

const DriverFailureModelStruct = Schema.TaggedStruct("model", {
  id: DriverFailureId,
})
const DriverFailureExternalStruct = Schema.TaggedStruct("external", {
  id: DriverFailureId,
})

/** Failure raised when a driver lookup or dispatch fails. */
export const DriverFailureRef = Schema.Union([
  DriverFailureModelStruct,
  DriverFailureExternalStruct,
]).pipe(Schema.toTaggedUnion("_tag"))
export type DriverFailureRef = Schema.Schema.Type<typeof DriverFailureRef>

export class DriverError extends Schema.TaggedErrorClass<DriverError>()("DriverError", {
  driver: DriverFailureRef,
  reason: Schema.String,
}) {}

// ── Shared types lifted from provider-contribution.ts ──

export class ProviderAuthError extends Schema.TaggedErrorClass<ProviderAuthError>()(
  "ProviderAuthError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
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

export interface ProviderAuthorizeContext {
  readonly sessionId: SessionId
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
  ) => Effect.Effect<ProviderAuthorizationResult | undefined, ProviderAuthError>
  readonly callback?: (ctx: ProviderCallbackContext) => Effect.Effect<void, ProviderAuthError>
}

// ── ModelDriverContribution — provider-shaped driver ──

/**
 * Registers a model provider as a driver. Same capability surface as the
 * pre- `ProviderContribution` — `id` doubles as the driver id, the model
 * returned by `resolveModel` provides an `effect/unstable/ai` LanguageModel,
 * `listModels` filters/extends the catalog, and `auth` wires the OAuth/API
 * key flow. The driver registry routes a `DriverRef({ _tag: "model", id })`
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
  ) => ProviderResolution
  /** Filter or extend the model catalog. */
  readonly listModels?: (
    baseCatalog: ReadonlyArray<Model>,
    authInfo?: ProviderAuthInfo,
  ) => ReadonlyArray<Model>
  /** Auth configuration — OAuth + API key methods + handlers. */
  readonly auth?: ProviderAuthContribution
}

// ── External-driver shapes ──
//
// External drivers stream upstream Effect AI response parts directly. Gent's
// durable events remain receipts derived at the runtime edge.
export type TurnStreamPart = Response.AnyPart

/** Failure raised by an external driver while streaming a turn. */
export class TurnError extends Schema.TaggedErrorClass<TurnError>()("TurnError", {
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

export interface ExternalToolRunnerService {
  readonly runTool: (toolName: string, args: unknown) => Effect.Effect<unknown>
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
  ) => Stream.Stream<TurnStreamPart, TurnError, ExternalToolRunner>
}

export type TurnToolEventMode = "capture-tool-calls" | "observe-external-tools"

export interface TurnSource {
  readonly driverKind: "model" | "external"
  readonly driverId?: string
  readonly stream: Stream.Stream<Response.AnyPart, ProviderError | TurnError>
  readonly toolEventMode: TurnToolEventMode
  readonly formatStreamError: (streamError: ProviderError | TurnError) => string
  readonly collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

// ── ExternalDriverContribution — turn-executor-shaped driver ──

/**
 * Tool surface a driver expects in its system prompt.
 *
 * - `native` — driver receives gent's normal `## Available Tools` listing
 *   and dispatches them directly. The default for everything that isn't
 *   an external sandbox (i.e. all model drivers).
 * - `codemode` — driver receives a single `execute` MCP tool that takes
 *   JS code; tool calls go through a `gent.<name>(args)` proxy. The
 *   `systemPrompt` slot replaces the native tool sections with a
 *   codemode listing so the model sees the right affordance.
 *
 * Prompt slots key off this metadata rather than driver-id heuristics —
 * see `acp-agents/index.ts`.
 */
export type ToolSurface = "native" | "codemode"

/**
 * Registers an external execution loop as a driver. The wrapped
 * `TurnExecutor` streams Effect AI response parts; the agent loop collects them into an
 * assistant draft. The driver registry routes a
 * `DriverRef({ _tag: "external", id })` to the matching contribution.
 */
export interface ExternalDriverContribution {
  /** Driver id — referenced by `agent.driver: DriverRef({ _tag: "external", id })`. */
  readonly id: string
  /** The turn executor implementation. */
  readonly executor: TurnExecutor
  /** How the driver consumes tools. Determines the tool surface section in
   *  the compiled system prompt. Defaults to `"native"`. */
  readonly toolSurface?: ToolSurface
  /**
   * Hook called by the runtime when a config change makes any cached
   * external session for this driver stale (e.g. `driver.set` /
   * `driver.clear` swaps an agent's routing). Implementations should tear
   * down every cached session keyed under this driver id. External drivers
   * are the only contributors to this primitive, and an absent `invalidate`
   * hides cache-staleness bugs. Stateless drivers supply `Effect.void`
   * explicitly so reviewers see the intent.
   */
  readonly invalidate: () => Effect.Effect<void>
}

export type AnyDriverContribution = ModelDriverContribution | ExternalDriverContribution
