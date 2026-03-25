import type { Effect, Layer, Schema } from "effect"
import type { AgentDefinition, AgentName } from "./agent"
import type { AgentEvent } from "./event"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import type { Message } from "./message"
import type { PermissionResult } from "./permission"
import type { AnyToolDefinition } from "./tool"
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

// Interceptor map — only hooks that have production callers

export interface ExtensionInterceptorMap {
  readonly "prompt.system": Interceptor<SystemPromptInput, string>
  readonly "tool.execute": Interceptor<ToolExecuteInput, unknown>
  readonly "permission.check": Interceptor<PermissionCheckInput, PermissionResult>
  readonly "context.messages": Interceptor<ContextMessagesInput, ReadonlyArray<Message>>
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
  readonly branchId: BranchId
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

/** What derive() produces — projections from extension state */
export interface ExtensionProjection {
  readonly toolPolicy?: ToolPolicyFragment
  readonly promptSections?: ReadonlyArray<PromptSection>
  /** Serializable UI model snapshot for client rendering */
  readonly uiModel?: unknown
}

export interface ExtensionIntentResult<State> {
  readonly state: State
  readonly effects?: ReadonlyArray<Effect.Effect<void>>
}

/** Extension state machine definition — reduce events, derive projections, handle intents */
export interface ExtensionStateMachine<State, Intent = void> {
  readonly id: string
  readonly initial: State
  readonly schema: Schema.Schema<State>
  readonly intentSchema?: Schema.Schema<Intent>
  /** Schema for the uiModel returned by derive() — used for transport encoding/validation */
  readonly uiModelSchema?: Schema.Schema<unknown>
  /** Reduce an agent event into new state */
  readonly reduce: (state: State, event: AgentEvent, ctx: ExtensionReduceContext) => State
  /** Derive projections from current state */
  readonly derive: (state: State, ctx: ExtensionDeriveContext) => ExtensionProjection
  /**
   * Handle a typed intent from the client. Only invoked after runtime validates
   * the intent's epoch is current — stale intents are rejected before reaching this.
   */
  readonly handleIntent?: (state: State, intent: Intent) => ExtensionIntentResult<State>
}

/** Tag-conditional tool injection — declarative replacement for old tools.visible interceptor */
export interface TagInjection {
  readonly tag: string
  readonly tools: ReadonlyArray<AnyToolDefinition>
}

// Extension Setup — what an extension provides

export interface ExtensionSetup {
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly hooks?: ExtensionHooks
  readonly layer?: Layer.Layer<unknown, unknown, unknown>
  /** Server-owned state machine for this extension */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly stateMachine?: ExtensionStateMachine<any, any>
  /** Declarative tag-conditional tool injections */
  readonly tagInjections?: ReadonlyArray<TagInjection>
}

// Extension — the core primitive

export interface GentExtension<Config = void> {
  readonly manifest: ExtensionManifest
  readonly configSchema?: Schema.Schema<Config>
  readonly setup: (ctx: {
    readonly cwd: string
    readonly config: Config
    readonly source: string
  }) => Effect.Effect<ExtensionSetup, ExtensionLoadError>
}

// Factory

export const defineExtension = <Config = void>(ext: GentExtension<Config>): GentExtension<Config> =>
  ext

export const defineInterceptor = <K extends ExtensionInterceptorKey>(
  key: K,
  run: ExtensionInterceptorMap[K],
): ExtensionInterceptorDescriptor<K> => ({ key, run })
