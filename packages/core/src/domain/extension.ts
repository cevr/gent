import type { Effect, Layer, Schema } from "effect"
import type { AgentDefinition, AgentName } from "./agent"
import type { AuthMethod, AuthAuthorizationMethod } from "./auth-method"
import type { AgentEvent } from "./event"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import type { Message, MessageMetadata } from "./message"
import type { PermissionResult } from "./permission"
import type { AnyToolDefinition, ToolAction } from "./tool"
import type { PromptSection } from "./prompt.js"

// Extension Manifest — authored by extension author

export interface ExtensionManifest {
  readonly id: string
  readonly version?: string
}

// Loaded Extension — manifest + derived metadata from loader

export interface LoadedExtension {
  readonly manifest: ExtensionManifest
  readonly kind: ExtensionKind
  readonly sourcePath: string
  readonly setup: ExtensionSetup
}

export type ExtensionKind = "builtin" | "user" | "project"

// Extension Load Error

export class ExtensionLoadError {
  readonly _tag = "ExtensionLoadError"
  constructor(
    readonly extensionId: string,
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}

// Run Context — per-run metadata for tag injection and tool policy decisions

export interface RunContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly parentToolCallId?: ToolCallId
  readonly tags?: ReadonlyArray<string>
  /** Whether this is an interactive session (human at the terminal).
   *  False for headless mode and subagent contexts. */
  readonly interactive?: boolean
}

// Interceptor type

export type Interceptor<I, O, E = never, R = never> = (
  input: I,
  next: (input: I) => Effect.Effect<O, E, R>,
) => Effect.Effect<O, E, R>

// Hook input types

export interface SystemPromptInput {
  readonly basePrompt: string
  readonly agent: AgentDefinition
}

export interface ToolExecuteInput {
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly input: unknown
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export interface PermissionCheckInput {
  readonly toolName: string
  readonly input: unknown
}

export interface ContextMessagesInput {
  readonly messages: ReadonlyArray<Message>
  readonly agent: AgentDefinition
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export interface TurnAfterInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly durationMs: number
  readonly agentName: AgentName
  readonly interrupted: boolean
}

export interface ToolResultInput {
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly toolAction: ToolAction
  readonly input: unknown
  readonly result: unknown
  readonly agentName?: AgentName
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

// Interceptor map — only hooks that have production callers

export interface ExtensionInterceptorMap {
  readonly "prompt.system": Interceptor<SystemPromptInput, string>
  readonly "tool.execute": Interceptor<ToolExecuteInput, unknown>
  readonly "permission.check": Interceptor<PermissionCheckInput, PermissionResult>
  readonly "context.messages": Interceptor<ContextMessagesInput, ReadonlyArray<Message>>
  /** Post-turn hook — extensions can schedule follow-ups, count turns, trigger side effects */
  readonly "turn.after": Interceptor<TurnAfterInput, void>
  /** Post-execution hook — extensions can enrich/append to tool results */
  readonly "tool.result": Interceptor<ToolResultInput, unknown>
}

export type ExtensionInterceptorKey = keyof ExtensionInterceptorMap

export type ExtensionInterceptorDescriptor<
  K extends ExtensionInterceptorKey = ExtensionInterceptorKey,
> = {
  readonly key: K
  readonly run: ExtensionInterceptorMap[K]
}

export interface ExtensionHooks {
  readonly interceptors?: ReadonlyArray<ExtensionInterceptorDescriptor>
}

// Extension State Machine — server-owned state that drives tool policy, prompt, and UI

export interface ExtensionReduceContext {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
}

export interface ExtensionDeriveContext {
  readonly agent: AgentDefinition
  readonly allTools: ReadonlyArray<AnyToolDefinition>
}

/** Fragment contributed by an extension's derive() to influence tool visibility */
export interface ToolPolicyFragment {
  /** Tool names to force-include */
  readonly include?: ReadonlyArray<string>
  /** Tool names to force-exclude */
  readonly exclude?: ReadonlyArray<string>
  /** If set, replaces the full tool list (before agent deny reapplication) */
  readonly overrideSet?: ReadonlyArray<string>
}

/** Turn-time projection — needs agent/tool context, used during prompt assembly */
export interface TurnProjection {
  readonly toolPolicy?: ToolPolicyFragment
  readonly promptSections?: ReadonlyArray<PromptSection>
}

/** What derive() produces — projections from extension state */
export interface ExtensionProjection extends TurnProjection {
  /** Serializable UI model snapshot for client rendering */
  readonly uiModel?: unknown
}

// Extension Actor — OTP-inspired unified state model

/** Typed effect union interpreted by the framework after reduce/handleIntent */
export type ExtensionEffect =
  | {
      readonly _tag: "QueueFollowUp"
      readonly content: string
      readonly metadata?: MessageMetadata
    }
  | { readonly _tag: "Interject"; readonly content: string }
  | { readonly _tag: "Persist" }

/** Result of a reduce or handleIntent call — always object form */
export interface ReduceResult<State> {
  readonly state: State
  readonly effects?: ReadonlyArray<ExtensionEffect>
}

/**
 * Unified actor interface for stateful extensions.
 * Lifecycle: spawn → init → handleEvent/handleIntent → terminate
 *
 * OTP GenServer-inspired: process owns state privately, framework owns observation.
 * handleEvent/handleIntent return boolean (changed) — no snapshot-for-change-detection.
 *
 * Supervision: handleEvent wrapped with catchDefect — crashing actor logs and continues.
 * Init failure → actor skipped with warning.
 */
export interface ExtensionActor {
  readonly id: string
  readonly init: Effect.Effect<void>
  readonly handleEvent: (event: AgentEvent, ctx: ExtensionReduceContext) => Effect.Effect<boolean>
  readonly handleIntent?: (intent: unknown, branchId?: BranchId) => Effect.Effect<boolean>
  readonly getState: Effect.Effect<{ state: unknown; version: number }>
  readonly terminate: Effect.Effect<void>
}

/**
 * Projection config — framework-owned, separated by boundary.
 *
 * Two boundaries, two derive functions:
 * - deriveTurn: needs {agent, allTools}, produces toolPolicy + promptSections
 * - deriveUi: state-only, produces uiModel for client rendering
 */
export interface ExtensionProjectionConfig {
  /** Turn-time projection — called during prompt assembly with full context */
  readonly deriveTurn?: (state: unknown, ctx: ExtensionDeriveContext) => TurnProjection
  /** UI projection — state-only, called for UI snapshots without turn context */
  readonly deriveUi?: (state: unknown) => unknown
  readonly uiModelSchema?: Schema.Schema<unknown>
}

/** Factory function that spawns an actor instance for a session.
 *  May require services from context — the runtime provides them at spawn time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SpawnActor<R = any> = (ctx: {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
}) => Effect.Effect<ExtensionActor, never, R>

/** Tag-conditional tool injection — declarative replacement for old tools.visible interceptor */
export interface TagInjection {
  readonly tag: string
  readonly tools: ReadonlyArray<AnyToolDefinition>
}

// Provider Contribution — what a provider extension registers

export interface ProviderContribution {
  /** Provider identifier — e.g. "anthropic", "openai", "my-custom" */
  readonly id: string
  /** Display name */
  readonly name: string
  /** Resolve a model name to a LanguageModel instance (typed as unknown to avoid domain→ai dep).
   *  authInfo is the stored auth from AuthStore (api key or oauth tokens), if available. */
  readonly resolveModel: (modelName: string, authInfo?: ProviderAuthInfo) => unknown
  /** Filter/extend the model catalog for this provider. authInfo provided when stored auth exists. */
  readonly listModels?: (
    baseCatalog: ReadonlyArray<unknown>,
    authInfo?: ProviderAuthInfo,
  ) => ReadonlyArray<unknown>
  /** Auth configuration — methods + authorize/callback handlers */
  readonly auth?: ProviderAuthContribution
  /** Build provider-specific options for the AI SDK. Called during stream/generate setup.
   *  Receives the model ID, reasoning level, and existing options — returns merged options. */
  readonly buildOptions?: (
    modelId: string,
    reasoning: string | undefined,
    existing: unknown,
  ) => unknown
}

/** Auth info passed to resolveModel — mirrors AuthStore entries */
export interface ProviderAuthInfo {
  readonly type: string
  readonly key?: string
  /** OAuth access token */
  readonly access?: string
  /** OAuth refresh token */
  readonly refresh?: string
  /** OAuth expiry timestamp (ms) */
  readonly expires?: number
  /** OAuth account ID */
  readonly accountId?: string
  /** Persist updated auth back to store (for token refresh) */
  readonly persist?: (updated: {
    access: string
    refresh: string
    expires: number
    accountId?: string
  }) => Promise<void>
}

/** Persist auth credentials — passed by ProviderAuth to extension auth handlers */
export type PersistAuth = (
  auth:
    | {
        readonly type: "api"
        readonly key: string
      }
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

export interface ProviderAuthContribution {
  readonly methods: ReadonlyArray<AuthMethod>
  readonly authorize?: (
    ctx: ProviderAuthorizeContext,
  ) => Effect.Effect<ProviderAuthorizationResult | undefined>
  readonly callback?: (ctx: ProviderCallbackContext) => Effect.Effect<void>
}

export interface ProviderAuthorizationResult {
  readonly url: string
  readonly method: AuthAuthorizationMethod
  readonly instructions?: string
}

// Interaction Handler Contributions

export type InteractionHandlerType = "permission" | "prompt" | "handoff" | "ask-user"

export interface InteractionHandlerContribution {
  readonly type: InteractionHandlerType
  /** Handler layer — requires EventStore | Storage. Materialized by dependencies.ts at the right point in the chain. */
  readonly layer: Layer.Any
}

// Extension Setup — what an extension provides

export interface ExtensionSetup {
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly hooks?: ExtensionHooks
  readonly layer?: Layer.Any
  /** Spawn an actor for this extension — unified lifecycle model */
  readonly spawnActor?: SpawnActor
  /** Projection config — derive function externalized from actor (framework-owned) */
  readonly projection?: ExtensionProjectionConfig
  /** Declarative tag-conditional tool injections */
  readonly tagInjections?: ReadonlyArray<TagInjection>
  /** Provider contributions — register AI provider implementations */
  readonly providers?: ReadonlyArray<ProviderContribution>
  /** Interaction handler implementations — replaces default handlers when provided */
  readonly interactionHandlers?: ReadonlyArray<InteractionHandlerContribution>
  /** Static prompt sections — merged into the base system prompt. Later scope shadows by section id. */
  readonly promptSections?: ReadonlyArray<PromptSection>
  /** One-time startup effect — runs during dependency initialization. No service requirements. */
  readonly onStartup?: Effect.Effect<void>
  /** Cleanup effect — runs as scope finalizer during graceful shutdown. */
  readonly onShutdown?: Effect.Effect<void>
}

// Extension — the core primitive

export interface GentExtension {
  readonly manifest: ExtensionManifest
  readonly setup: (ctx: {
    readonly cwd: string
    readonly source: string
  }) => Effect.Effect<ExtensionSetup, ExtensionLoadError>
}

// Factory

export const defineExtension = (ext: GentExtension): GentExtension => ext

export const defineInterceptor = <K extends ExtensionInterceptorKey>(
  key: K,
  run: ExtensionInterceptorMap[K],
): ExtensionInterceptorDescriptor<K> => ({ key, run })
