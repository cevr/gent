import type { Effect, FileSystem, Path } from "effect"
import { Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Machine, ProvideSlots, SlotCalls, SlotsDef } from "effect-machine"
import type { AgentDefinition, AgentName, DriverSource } from "./agent"
import type { AnyCapabilityContribution } from "./capability"
import type { AgentEvent } from "./event"
import type { BranchId, SessionId, ToolCallId } from "./ids"
import type { Message, MessageMetadata, MessagePart } from "./message"
import type { ExtensionContributions } from "./contribution.js"
export type { ExtensionContributions } from "./contribution.js"
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
  /**
   * Typed contribution buckets produced by the extension's setup function.
   * Consumers (registries, workflow runtime, scheduler, projection registry,
   * etc.) read each bucket directly — `contributions.capabilities`,
   * `contributions.resources`, etc. The bucket name IS the discrimination;
   * there is no `_kind` discriminator and no `filterByKind`.
   */
  readonly contributions: ExtensionContributions
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

export class ExtensionLoadError extends Schema.TaggedErrorClass<ExtensionLoadError>(
  "@gent/core/domain/extension/ExtensionLoadError",
)("ExtensionLoadError", {
  extensionId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Run Context — per-run metadata for tool policy decisions

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

// Turn-scoped input shapes for the explicit runtime seams. Prompt/context
// shaping lives on `Projection`; turn/message reactions and tool-result
// enrichment live on `Resource.runtime`.

export interface SystemPromptInput {
  readonly basePrompt: string
  readonly agent: AgentDefinition
  readonly interactive?: boolean
  /**
   * Origin of the resolved driver for this turn. Set by the agent loop
   * after `resolveAgentDriver` runs. Prompt slots read this to detect
   * external dispatch (e.g. ACP via codemode) and rewrite the prompt's
   * tool section accordingly. `undefined` for code paths that bypass
   * `resolveTurnContext`.
   */
  readonly driverSource?: DriverSource
  /**
   * Tools resolved for this turn. ACP-aware hooks need this to render
   * the codemode `gent.<tool>(...)` shape into the rewritten prompt.
   */
  readonly tools?: ReadonlyArray<AnyCapabilityContribution>
  /**
   * Tool surface declared by the resolved driver (`"native"` or
   * `"codemode"`). Set by the agent loop from
   * `ExternalDriverContribution.toolSurface`; `undefined` for
   * model-routed turns. The codemode prompt slot keys off this metadata
   * rather than driver-id heuristics.
   */
  readonly driverToolSurface?: "native" | "codemode"
  /**
   * The structured prompt sections used to build `basePrompt`, in
   * pre-compile form. Prompt slots that need to swap or strip
   * sections (e.g. codemode replacing `tool-list` / `tool-guidelines`)
   * rewrite this and recompile rather than performing string surgery.
   */
  readonly sections?: ReadonlyArray<{
    readonly id: string
    readonly content: string
    readonly priority: number
  }>
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

export interface TurnBeforeInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName: AgentName
  readonly toolCount: number
  readonly systemPromptLength: number
}

export interface TurnAfterInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly durationMs: number
  readonly agentName: AgentName
  readonly interrupted: boolean
}

export interface MessageOutputInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName: AgentName
  readonly parts: ReadonlyArray<MessagePart>
}

export interface ToolResultInput {
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly input: unknown
  readonly result: unknown
  readonly agentName?: AgentName
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

export interface MessageInputInput {
  readonly content: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

// Extension State Machine — server-owned state that drives tool policy, prompt, and UI

export interface ExtensionReduceContext {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
}

export interface ExtensionTurnContext extends RunContext {
  readonly agent: AgentDefinition
  readonly allTools: ReadonlyArray<AnyCapabilityContribution>
}

/** @deprecated Use ExtensionTurnContext */
export type ExtensionDeriveContext = ExtensionTurnContext

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

// Extension Actor — OTP-inspired unified state model

/** Public effect union available to extension authors. */
export type ExtensionEffect =
  | { readonly _tag: "BusEmit"; readonly channel: string; readonly payload: unknown }
  | { readonly _tag: "Send"; readonly message: AnyExtensionCommandMessage }

/** Internal runtime-only effects interpreted by the framework after transitions. */
export type RuntimeExtensionEffect =
  | {
      readonly _tag: "QueueFollowUp"
      readonly content: string
      readonly metadata?: MessageMetadata
    }
  | { readonly _tag: "Interject"; readonly content: string }
  | ExtensionEffect

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
  readonly execute: <M extends AnyExtensionRequestMessage>(
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
  /** State schema enables persistence — if set, the actor's state is persisted
   *  via effect-machine's Recovery + Durability lifecycle. */
  readonly stateSchema?: Schema.Schema<State>
  /** Protocol definitions owned by this actor. */
  readonly protocols?: Readonly<Record<string, unknown>>
  readonly afterTransition?: (before: State, after: State) => ReadonlyArray<ExtensionEffect>
  readonly onInit?: (ctx: {
    readonly sessionId: SessionId
    readonly snapshot: Effect.Effect<State>
    readonly send: (event: Event) => Effect.Effect<boolean>
    readonly sessionCwd?: string
    readonly parentSessionId?: SessionId
    readonly getSessionAncestors: () => Effect.Effect<ReadonlyArray<{ readonly id: string }>>
    readonly slots?: SlotCalls<SD>
  }) => Effect.Effect<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExtensionActorDefinition = ExtensionActorDefinition<any, any, any, any>

// `CommandContribution` (server slash commands) was deleted in C8 — no
// extension contributes one anymore (executor migrated to a Capability with
// `audiences:["human-slash"]` in C4.3). The TUI's separate client-facet
// `_kind: "command"` model is unrelated.

// Turn executor types — owned by the driver primitive (external drivers wrap them).
export type { TurnExecutor, TurnContext, TurnEvent, TurnError } from "./driver.js"

// Driver auth + hint shared types — re-exported from dedicated file
//
// Lives in driver.ts now (was provider-contribution.ts pre-C9). Re-exported
// here so existing internal consumers keep their import paths through
// `domain/extension.js`.

export type {
  ProviderAuthInfo,
  ProviderHints,
  PersistAuth,
  ProviderAuthorizeContext,
  ProviderCallbackContext,
  ProviderAuthContribution,
  ProviderAuthorizationResult,
} from "./driver.js"

// Extension — the core primitive

/** Context provided to extension setup functions. */
export interface ExtensionSetupContext {
  readonly cwd: string
  readonly source: string
  /** User home directory (e.g. ~/.gent lives here). Defaults to os.homedir(). */
  readonly home: string
  /** Platform FileSystem service (captured from Effect context at setup time). */
  readonly fs: FileSystem.FileSystem
  /** Platform Path service (captured from Effect context at setup time). */
  readonly path: Path.Path
  /** Platform ChildProcessSpawner service (captured from Effect context at setup time). */
  readonly spawner: ChildProcessSpawner["Service"]
}

export interface GentExtension {
  readonly manifest: ExtensionManifest
  /**
   * Returns the typed `ExtensionContributions` buckets for this extension.
   * The runtime stores this directly on `LoadedExtension.contributions`;
   * consumers read each bucket as a typed array. After C8 there is no flat
   * `Contribution[]` and no `_kind` discriminator.
   */
  readonly setup: (
    ctx: ExtensionSetupContext,
  ) => Effect.Effect<ExtensionContributions, ExtensionLoadError>
}

// Legacy keyed middleware primitives are gone. Prompt/context shaping now
// lives on `Projection`; turn/message reactions and tool-result enrichment
// live on `Resource.runtime`.
