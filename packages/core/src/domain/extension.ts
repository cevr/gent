import type { Effect, Layer, Schema } from "effect"
import type { AgentDefinition, AgentName } from "./agent"
import type { BranchId, SessionId } from "./ids"
import type { ToolResultPart } from "./message"
import type { PermissionResult } from "./permission"
import type { AnyToolDefinition } from "./tool"
import type { ProviderRequest } from "../providers/provider"

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

// System Prompt Fragment — contributed by extensions

export interface SystemPromptFragment {
  readonly section: "guidelines" | "tools" | "context" | "custom"
  readonly content: string
  readonly priority?: number
}

// Run Context — per-run metadata for tools.visible decisions

export interface RunContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly parentToolCallId?: string
  readonly tags?: ReadonlyArray<string>
}

// Interceptor + Observer types

export type Interceptor<I, O, E = never, R = never> = (
  input: I,
  next: (input: I) => Effect.Effect<O, E, R>,
) => Effect.Effect<O, E, R>

export type Observer<I, E = never, R = never> = (input: I) => Effect.Effect<void, E, R>

// Hook input types

export interface SystemPromptInput {
  readonly basePrompt: string
  readonly agent: AgentDefinition
}

export interface AgentResolveInput {
  readonly name: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export interface ToolsVisibleInput {
  readonly agent: AgentDefinition
  readonly tools: ReadonlyArray<AnyToolDefinition>
  readonly runContext: RunContext
}

export interface ToolExecuteInput {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export interface ProviderRequestInput {
  readonly request: ProviderRequest
  readonly agent: AgentDefinition
}

export interface PermissionCheckInput {
  readonly toolName: string
  readonly input: unknown
}

// Extension Hook Map

export interface ExtensionHookMap {
  readonly "prompt.system": Interceptor<SystemPromptInput, string>
  readonly "agent.resolve": Interceptor<AgentResolveInput, AgentDefinition>
  readonly "tools.visible": Interceptor<ToolsVisibleInput, ReadonlyArray<AnyToolDefinition>>
  readonly "tool.execute": Interceptor<ToolExecuteInput, ToolResultPart>
  readonly "provider.request": Interceptor<ProviderRequestInput, ProviderRequest>
  readonly "permission.check": Interceptor<PermissionCheckInput, PermissionResult>

  // Lifecycle observers — event types reused from domain/event.ts
  readonly "session.start": Observer<{ sessionId: SessionId; branchId: BranchId }>
  readonly "session.end": Observer<{ sessionId: SessionId }>
  readonly "handoff.before": Observer<{ sessionId: SessionId; context: string }>
  readonly "handoff.after": Observer<{ sessionId: SessionId; newSessionId: SessionId }>
  readonly "agent.start": Observer<{ sessionId: SessionId; branchId: BranchId }>
  readonly "agent.end": Observer<{ sessionId: SessionId; branchId: BranchId }>
  readonly "agent.switch": Observer<{
    sessionId: SessionId
    branchId: BranchId
    from: AgentName
    to: AgentName
  }>
  readonly "turn.start": Observer<{ sessionId: SessionId; branchId: BranchId }>
  readonly "turn.end": Observer<{
    sessionId: SessionId
    branchId: BranchId
    durationMs: number
  }>
  readonly "stream.start": Observer<{ sessionId: SessionId; branchId: BranchId }>
  readonly "stream.end": Observer<{
    sessionId: SessionId
    branchId: BranchId
    usage?: { inputTokens: number; outputTokens: number }
  }>
  readonly "tool.call": Observer<{
    sessionId: SessionId
    branchId: BranchId
    toolCallId: string
    toolName: string
  }>
  readonly "tool.result": Observer<{
    sessionId: SessionId
    branchId: BranchId
    toolCallId: string
    toolName: string
    isError: boolean
  }>
  readonly "message.received": Observer<{
    sessionId: SessionId
    branchId: BranchId
    messageId: string
    role: string
  }>
}

// Extension Setup — what an extension provides

export interface ExtensionSetup {
  readonly tools?: ReadonlyArray<AnyToolDefinition>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly promptFragments?: ReadonlyArray<SystemPromptFragment>
  readonly hooks?: Partial<ExtensionHookMap>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly layer?: Layer.Layer<any, any, any>
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
