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
import type { ExtensionHostContext } from "./extension-host-context.js"
import type { BranchId, SessionId } from "./ids.js"
import type { Message } from "./message.js"
import type { AnyToolDefinition } from "./tool.js"
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
export class DriverError extends Schema.TaggedErrorClass<DriverError>()("DriverError", {
  kind: Schema.Literals(["model", "external"]),
  id: Schema.String,
  reason: Schema.String,
}) {}

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
 * Authored via `TaggedEnumClass` (S0 substrate). Validates the factory's
 * handling of non-identifier tag names (kebab-case): variants are accessed
 * as `TurnEvent["text-delta"]` rather than `TurnEvent.textDelta`. Pattern
 * matching via `_tag === "text-delta"` or `Match.tag` works unchanged.
 */
export const TurnEvent = TaggedEnumClass("TurnEvent", {
  "text-delta": {
    text: Schema.String,
  },
  "reasoning-delta": {
    text: Schema.String,
  },
  "tool-started": {
    toolCallId: Schema.String,
    toolName: Schema.String,
    input: Schema.optional(Schema.Unknown),
  },
  "tool-completed": {
    toolCallId: Schema.String,
    output: Schema.optional(Schema.Unknown),
  },
  "tool-failed": {
    toolCallId: Schema.String,
    error: Schema.String,
  },
  finished: {
    stopReason: Schema.String,
    usage: Schema.optional(TurnEventUsage),
  },
})
export type TurnEvent = Schema.Schema.Type<typeof TurnEvent>

// Per-variant re-exports — same class identity as `TurnEvent["text-delta"]`,
// exposed at module scope for ergonomic imports. The kebab-case wire tags
// stay; the JS-friendly names below are the natural identifier form.
export const TextDelta = TurnEvent["text-delta"]
export type TextDelta = (typeof TurnEvent)["text-delta"]["Type"]
export const ReasoningDelta = TurnEvent["reasoning-delta"]
export type ReasoningDelta = (typeof TurnEvent)["reasoning-delta"]["Type"]
export const ToolStarted = TurnEvent["tool-started"]
export type ToolStarted = (typeof TurnEvent)["tool-started"]["Type"]
export const ToolCompleted = TurnEvent["tool-completed"]
export type ToolCompleted = (typeof TurnEvent)["tool-completed"]["Type"]
export const ToolFailed = TurnEvent["tool-failed"]
export type ToolFailed = (typeof TurnEvent)["tool-failed"]["Type"]
export const Finished = TurnEvent.finished
export type Finished = (typeof TurnEvent)["finished"]["Type"]

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
  readonly tools: ReadonlyArray<AnyToolDefinition>
  readonly systemPrompt: string
  readonly cwd: string
  readonly abortSignal: AbortSignal
  readonly hostCtx: ExtensionHostContext
}

/** Executor interface implemented by external drivers (ACP agents, etc.). */
export interface TurnExecutor {
  readonly executeTurn: (ctx: TurnContext) => Stream.Stream<TurnEvent, TurnError>
  readonly cancel?: (sessionId: string) => Effect.Effect<void>
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
 *   `prompt.system` pipeline replaces the native tool sections with a
 *   codemode listing so the model sees the right affordance.
 *
 * Pipelines key off this metadata rather than driver-id heuristics —
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
}

export type AnyDriverContribution = ModelDriverContribution | ExternalDriverContribution
