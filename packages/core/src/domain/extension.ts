import type { Effect, Layer, Schema } from "effect"
import type { Machine, ProvideSlots, SlotCalls, SlotsDef } from "effect-machine"
import type { AgentDefinition, AgentName } from "./agent"
import type { AgentEvent } from "./event"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import type { Message, MessageMetadata } from "./message"
import type { PermissionResult } from "./permission"
import type { AnyToolDefinition, ToolAction } from "./tool"
import type { ExtensionHostContext } from "./extension-host-context"
import type { PromptSection } from "./prompt.js"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtensionProtocolError,
  ExtractExtensionReply,
} from "./extension-protocol.js"

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

export type FailedExtensionPhase = "setup" | "validation" | "startup"

export interface FailedExtension {
  readonly manifest: ExtensionManifest
  readonly kind: ExtensionKind
  readonly sourcePath: string
  readonly phase: FailedExtensionPhase
  readonly error: string
}

export interface ScheduledJobFailureInfo {
  readonly jobId: string
  readonly error: string
}

export type ExtensionStatusInfo =
  | {
      readonly manifest: ExtensionManifest
      readonly kind: ExtensionKind
      readonly sourcePath: string
      readonly status: "active"
      readonly actor?: ExtensionActorStatusInfo
      readonly scheduledJobFailures?: ReadonlyArray<ScheduledJobFailureInfo>
    }
  | ({
      readonly manifest: ExtensionManifest
      readonly kind: ExtensionKind
      readonly sourcePath: string
      readonly status: "failed"
      readonly actor?: ExtensionActorStatusInfo
      readonly scheduledJobFailures?: ReadonlyArray<ScheduledJobFailureInfo>
    } & FailedExtension)

export type ExtensionActorLifecycleStatus = "starting" | "running" | "restarting" | "failed"

export type ExtensionActorFailurePhase = "start" | "runtime"

export interface ExtensionActorStatusInfo {
  readonly extensionId: string
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  readonly status: ExtensionActorLifecycleStatus
  readonly restartCount?: number
  readonly error?: string
  readonly failurePhase?: ExtensionActorFailurePhase
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
  ctx: ExtensionHostContext,
) => Effect.Effect<O, E, R>

// Hook input types

export interface SystemPromptInput {
  readonly basePrompt: string
  readonly agent: AgentDefinition
  readonly interactive?: boolean
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
  readonly sessionId: SessionId
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

export interface ExtensionActorSnapshotConfig<State = unknown> {
  /** Optional runtime validation for the public snapshot payload. */
  readonly schema?: Schema.Schema<unknown>
  /** If omitted, runtime uses actor state as the public snapshot. */
  readonly project?: (state: State) => unknown
}

export interface ExtensionActorTurnConfig<State = unknown> {
  /** Derive turn directives from actor state. Pure projection only. */
  readonly project: (state: State, ctx: ExtensionDeriveContext) => TurnProjection
}

// Extension Actor — OTP-inspired unified state model

/** Typed effect union interpreted by the framework after actor transitions */
export type ExtensionEffect =
  | {
      readonly _tag: "QueueFollowUp"
      readonly content: string
      readonly metadata?: MessageMetadata
    }
  | { readonly _tag: "Interject"; readonly content: string }
  | { readonly _tag: "Persist" }
  | { readonly _tag: "BusEmit"; readonly channel: string; readonly payload: unknown }
  | { readonly _tag: "Send"; readonly message: AnyExtensionCommandMessage }

/** Result of a reducer/message handler call — always object form */
export interface ReduceResult<State> {
  readonly state: State
  readonly effects?: ReadonlyArray<ExtensionEffect>
}

/** Result of a request handler call — can reply and optionally transition state. */
export interface RequestResult<State, Reply> extends ReduceResult<State> {
  readonly reply: Reply
}

export interface ExtensionSnapshot {
  readonly state: unknown
  readonly epoch: number
}

/**
 * Session-scoped extension actor/ref.
 * Lifecycle: spawn → start → publish/send/ask → snapshot → stop
 *
 * `ask` is always part of the boundary. Requests with no meaningful payload
 * reply should use `void` / `null` schemas. Unsupported requests fail loudly.
 */
export interface ExtensionRef {
  readonly id: string
  readonly start: Effect.Effect<void, ExtensionProtocolError>
  readonly publish: (
    event: AgentEvent,
    ctx: ExtensionReduceContext,
  ) => Effect.Effect<boolean, ExtensionProtocolError>
  readonly send: (
    message: AnyExtensionCommandMessage,
    branchId?: BranchId,
  ) => Effect.Effect<void, ExtensionProtocolError>
  readonly ask: <M extends AnyExtensionRequestMessage>(
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>
  readonly snapshot: Effect.Effect<ExtensionSnapshot, ExtensionProtocolError>
  readonly stop: Effect.Effect<void>
}

export interface ExtensionActorDefinition<
  State extends { readonly _tag: string } = { readonly _tag: string },
  Event extends { readonly _tag: string } = { readonly _tag: string },
  SlotsR = never,
  SD extends SlotsDef = Record<string, never>,
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly machine: Machine.Machine<State, Event, never, any, any, SD>
  readonly slots?: (ctx: {
    readonly sessionId: SessionId
    readonly branchId?: BranchId
  }) => Effect.Effect<ProvideSlots<SD>, never, SlotsR>
  readonly mapEvent?: (event: AgentEvent) => Event | undefined
  readonly mapCommand?: (message: AnyExtensionCommandMessage, state: State) => Event | undefined
  readonly mapRequest?: (message: AnyExtensionRequestMessage, state: State) => Event | undefined
  readonly snapshot?: ExtensionActorSnapshotConfig<State>
  readonly turn?: ExtensionActorTurnConfig<State>
  readonly stateSchema?: Schema.Schema<State>
  readonly persist?: boolean
  /** Protocol definitions owned by this actor. */
  readonly protocols?: Readonly<Record<string, unknown>>
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<ExtensionEffect>
  readonly onInit?: (ctx: {
    readonly sessionId: SessionId
    readonly snapshot: Effect.Effect<State>
    readonly send: (event: Event) => Effect.Effect<boolean>
    readonly sessionCwd?: string
    readonly slots?: SlotCalls<SD>
  }) => Effect.Effect<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExtensionActorDefinition = ExtensionActorDefinition<any, any, any, any>

/** Tag-conditional tool injection — declarative replacement for old tools.visible interceptor */
export interface TagInjection {
  readonly tag: string
  readonly tools: ReadonlyArray<AnyToolDefinition>
}

// Provider Contribution — re-exported from dedicated file for backwards compatibility

export type {
  ProviderContribution,
  ProviderAuthInfo,
  PersistAuth,
  ProviderAuthorizeContext,
  ProviderCallbackContext,
  ProviderAuthContribution,
  ProviderAuthorizationResult,
} from "./provider-contribution.js"
import type { ProviderContribution } from "./provider-contribution.js"

export interface ScheduledJobHeadlessAgentTarget {
  readonly kind: "headless-agent"
  readonly agent: AgentName
  readonly prompt: string
  readonly cwd?: string
}

export type ScheduledJobTarget = ScheduledJobHeadlessAgentTarget

export interface ScheduledJobContribution {
  /** Extension-local id. Host namespaces with extension id when installing. */
  readonly id: string
  readonly schedule: string
  readonly target: ScheduledJobTarget
}

// Extension Setup — what an extension provides

export interface ExtensionSetup {
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly hooks?: ExtensionHooks
  readonly layer?: Layer.Layer<never, never, object>
  /** Session-scoped stateful actor. Omit for stateless extensions. */
  readonly actor?: AnyExtensionActorDefinition
  /** Declarative tag-conditional tool injections */
  readonly tagInjections?: ReadonlyArray<TagInjection>
  /** Provider contributions — register AI provider implementations */
  readonly providers?: ReadonlyArray<ProviderContribution>
  /** Durable host-owned scheduled jobs contributed by the extension. */
  readonly jobs?: ReadonlyArray<ScheduledJobContribution>
  /** Static prompt sections — merged into the base system prompt. Later scope shadows by section id. */
  readonly promptSections?: ReadonlyArray<PromptSection>
  /** Bus channel subscriptions — registered at startup time.
   *  Each entry: { pattern, handler } where handler receives BusEnvelope.
   *  Handler can return void, Promise<void>, or Effect<void>. */
  readonly busSubscriptions?: ReadonlyArray<{
    readonly pattern: string
    readonly handler: (envelope: {
      channel: string
      payload: unknown
      sessionId?: string
      branchId?: string
    }) => void | Promise<void> | Effect.Effect<void>
  }>
  /** One-time startup effect — runs during dependency initialization. No service requirements. */
  readonly onStartup?: Effect.Effect<void>
  /** Cleanup effect — runs as scope finalizer during graceful shutdown. */
  readonly onShutdown?: Effect.Effect<void>
}

// Extension — the core primitive

/** Context provided to extension setup functions. */
export interface ExtensionSetupContext {
  readonly cwd: string
  readonly source: string
  /** User home directory (e.g. ~/.gent lives here). Defaults to os.homedir(). */
  readonly home: string
}

export interface GentExtension {
  readonly manifest: ExtensionManifest
  readonly setup: (ctx: ExtensionSetupContext) => Effect.Effect<ExtensionSetup, ExtensionLoadError>
}

// Factory

export const defineInterceptor = <K extends ExtensionInterceptorKey>(
  key: K,
  run: ExtensionInterceptorMap[K],
): ExtensionInterceptorDescriptor<K> => ({ key, run })
