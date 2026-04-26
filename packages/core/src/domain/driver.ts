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
import { Schema, type Effect, type Layer, type Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { AgentDefinition } from "./agent.js"
import type { AuthAuthorizationMethod, AuthMethod } from "./auth-method.js"
import type { AnyCapabilityContribution } from "./capability.js"
import type { ExtensionHostContext } from "./extension-host-context.js"
import { ToolCallId, type BranchId, type SessionId } from "./ids.js"
import type { Message } from "./message.js"
import type { Model } from "./model.js"
import type { ProviderError } from "../providers/provider.js"
import { TaggedEnumClass } from "./schema-tagged-enum-class.js"

// Note: TurnExecutor is defined below alongside the driver primitives — no
// external import of `TurnExecutor` is needed.

// ── Driver reference re-export ──
//
// The canonical `DriverRef` schema lives on `AgentDefinition` (so it survives
// JSON roundtrips through `Schema.Class`). Re-exported here for callers that
// reach through the driver primitive.
export { DriverRef, ModelDriverRef, ExternalDriverRef } from "./agent.js"

// ── Failure type ──

/** Failure raised when a driver lookup or dispatch fails. */
export const DriverFailureRef = TaggedEnumClass("DriverFailureRef", {
  Model: TaggedEnumClass.variant("model", {
    id: Schema.String,
  }),
  External: TaggedEnumClass.variant("external", {
    id: Schema.String,
  }),
})
export type DriverFailureRef = typeof DriverFailureRef.Type

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
    baseCatalog: ReadonlyArray<Model>,
    authInfo?: ProviderAuthInfo,
  ) => ReadonlyArray<Model>
  /** Auth configuration — OAuth + API key methods + handlers. */
  readonly auth?: ProviderAuthContribution
}

// ── External-driver shapes ──
//
// What an external driver streams back per turn (TurnEvent), the per-turn
// context it receives (TurnContext), the failure type it can raise (TurnError),
// and the executor interface itself (TurnExecutor) live here as part of the
// driver primitive. Pre-C9 they were a parallel `domain/turn-executor.ts`
// primitive — collapsed into the driver module to remove the parallel API.

export const TurnEventUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
})
export type TurnEventUsage = typeof TurnEventUsage.Type

/**
 * `TurnEvent` — what an external driver streams back per turn.
 *
 * Authored via `TaggedEnumClass`. Kebab-case wire tags are pinned with
 * `TaggedEnumClass.variant(...)`, while constructors stay on PascalCase
 * members such as `TurnEvent.TextDelta`.
 */
export const TurnEvent = TaggedEnumClass("TurnEvent", {
  TextDelta: TaggedEnumClass.variant("text-delta", {
    text: Schema.String,
  }),
  ReasoningDelta: TaggedEnumClass.variant("reasoning-delta", {
    text: Schema.String,
  }),
  ToolCall: TaggedEnumClass.variant("tool-call", {
    toolCallId: ToolCallId,
    toolName: Schema.String,
    input: Schema.Unknown,
  }),
  ToolStarted: TaggedEnumClass.variant("tool-started", {
    toolCallId: ToolCallId,
    toolName: Schema.String,
    input: Schema.optional(Schema.Unknown),
  }),
  ToolCompleted: TaggedEnumClass.variant("tool-completed", {
    toolCallId: ToolCallId,
    output: Schema.optional(Schema.Unknown),
  }),
  ToolFailed: TaggedEnumClass.variant("tool-failed", {
    toolCallId: ToolCallId,
    error: Schema.String,
  }),
  Finished: TaggedEnumClass.variant("finished", {
    stopReason: Schema.String,
    usage: Schema.optional(TurnEventUsage),
  }),
})
export type TurnEvent = Schema.Schema.Type<typeof TurnEvent>

// Per-variant re-exports — same class identity as the direct enum members.
export const TextDelta = TurnEvent.TextDelta
export type TextDelta = typeof TurnEvent.TextDelta.Type
export const ReasoningDelta = TurnEvent.ReasoningDelta
export type ReasoningDelta = typeof TurnEvent.ReasoningDelta.Type
export const ToolCall = TurnEvent.ToolCall
export type ToolCall = typeof TurnEvent.ToolCall.Type
export const ToolStarted = TurnEvent.ToolStarted
export type ToolStarted = typeof TurnEvent.ToolStarted.Type
export const ToolCompleted = TurnEvent.ToolCompleted
export type ToolCompleted = typeof TurnEvent.ToolCompleted.Type
export const ToolFailed = TurnEvent.ToolFailed
export type ToolFailed = typeof TurnEvent.ToolFailed.Type
export const Finished = TurnEvent.Finished
export type Finished = typeof TurnEvent.Finished.Type

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
  readonly tools: ReadonlyArray<AnyCapabilityContribution>
  readonly systemPrompt: string
  readonly cwd: string
  readonly abortSignal: AbortSignal
  readonly hostCtx: ExtensionHostContext
}

/** Executor interface implemented by external drivers (ACP agents, etc.).
 *
 *  Cancellation is per-turn via `ctx.abortSignal` inside `executeTurn` — each
 *  driver wires the signal to its own cancel mechanism (ACP `conn.cancel`,
 *  SDK `q.interrupt`). A driver-wide `cancel(sessionId)` hook would only see
 *  the outer session string, not the full `(sessionId, branchId, driverId)`
 *  cache key, so it cannot target a specific cached session correctly.
 *  Counsel C5 — drop the dead optional rather than keep it as a no-op stub. */
export interface TurnExecutor {
  readonly executeTurn: (ctx: TurnContext) => Stream.Stream<TurnEvent, TurnError>
}

export type TurnToolEventMode = "capture-tool-calls" | "observe-external-tools"

export interface TurnSource {
  readonly driverKind: "model" | "external"
  readonly driverId?: string
  readonly stream: Stream.Stream<TurnEvent, ProviderError | TurnError>
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
 * `TurnExecutor` streams `TurnEvent`s; the agent loop collects them into an
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
   * down every cached session keyed under this driver id. Counsel C6 —
   * required, not optional: external drivers are the only contributors to
   * this primitive, and an absent `invalidate` hides cache-staleness bugs
   * (the BLOCKER fixed in C1 only mattered because we *expected* tearDown
   * to fully reclaim resources). Stateless drivers supply `Effect.void`
   * explicitly so reviewers see the intent.
   */
  readonly invalidate: () => Effect.Effect<void>
}

export type AnyDriverContribution = ModelDriverContribution | ExternalDriverContribution
