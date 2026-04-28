import type { Effect, FileSystem, Path } from "effect"
import { Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { AgentDefinition, AgentName, DriverSource } from "./agent"
import type { ToolToken } from "./capability/tool.js"
import { BranchId, ExtensionId, SessionId, type ToolCallId } from "./ids"
import type { Message, MessagePart } from "./message"
import type { ExtensionContributions } from "./contribution.js"
export type { ExtensionContributions } from "./contribution.js"
import type { PromptSection } from "./prompt.js"
import { TaggedEnumClass } from "./schema-tagged-enum-class.js"
import type { ExtensionHostContext } from "./extension-host-context.js"

// Extension Manifest — authored by extension author

export interface ExtensionManifest {
  readonly id: ExtensionId
  readonly version?: string
}

// Loaded Extension — manifest + derived metadata from loader

export interface LoadedExtension {
  readonly manifest: ExtensionManifest
  readonly scope: ExtensionScope
  readonly sourcePath: string
  /**
   * Typed contribution buckets produced by the extension's setup function.
   * Consumers (registries, workflow runtime, scheduler, turn reactions,
   * etc.) read each bucket directly — `contributions.tools`,
   * `contributions.commands`, `contributions.resources`, etc. The bucket name IS the discrimination;
   * there is no `_kind` discriminator and no `filterByKind`.
   */
  readonly contributions: ExtensionContributions
}

export type FailedExtensionPhase = "setup" | "validation" | "startup"

export interface FailedExtension {
  readonly manifest: ExtensionManifest
  readonly scope: ExtensionScope
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
      readonly scope: ExtensionScope
      readonly sourcePath: string
      readonly status: "active"
      readonly actor?: ExtensionActorStatusInfo
      readonly scheduledJobFailures?: ReadonlyArray<ScheduledJobFailureInfo>
    }
  | ({
      readonly manifest: ExtensionManifest
      readonly scope: ExtensionScope
      readonly sourcePath: string
      readonly status: "failed"
      readonly actor?: ExtensionActorStatusInfo
      readonly scheduledJobFailures?: ReadonlyArray<ScheduledJobFailureInfo>
    } & FailedExtension)

export const ExtensionActorFailurePhase = Schema.Literals(["start", "runtime"])
export type ExtensionActorFailurePhase = typeof ExtensionActorFailurePhase.Type

const ExtensionActorStatusFields = {
  extensionId: ExtensionId,
  sessionId: SessionId,
  branchId: Schema.optional(BranchId),
}

export const ExtensionActorStatusInfo = TaggedEnumClass("ExtensionActorStatusInfo", {
  Starting: TaggedEnumClass.variant("starting", ExtensionActorStatusFields),
  Running: TaggedEnumClass.variant("running", {
    ...ExtensionActorStatusFields,
    restartCount: Schema.optional(Schema.Number),
  }),
  Restarting: TaggedEnumClass.variant("restarting", {
    ...ExtensionActorStatusFields,
    restartCount: Schema.Number,
  }),
  Failed: TaggedEnumClass.variant("failed", {
    ...ExtensionActorStatusFields,
    error: Schema.String,
    failurePhase: ExtensionActorFailurePhase,
    restartCount: Schema.optional(Schema.Number),
  }),
})
export type ExtensionActorStatusInfo = typeof ExtensionActorStatusInfo.Type

export type ExtensionScope = "builtin" | "user" | "project"

// Extension Load Error

export class ExtensionLoadError extends Schema.TaggedErrorClass<ExtensionLoadError>(
  "@gent/core/domain/extension/ExtensionLoadError",
)("ExtensionLoadError", {
  extensionId: ExtensionId,
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
  readonly tools?: ReadonlyArray<ToolToken>
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

// ── Lifecycle reactions ──
//
// Per-extension, per-session handlers run by the runtime at the
// `turnBefore` / `turnAfter` / `messageOutput` / `toolResult` seams.
// Authored on `defineExtension({ reactions })`.

/**
 * Failure policy for a single reaction handler.
 *
 * - `continue` — log at debug; the failure is shrugged off (use for handlers
 *   whose absence is acceptable).
 * - `isolate` — log at warn; the failure is contained (use for best-effort
 *   side effects, e.g. context-fill handoff).
 * - `halt` — log at error and tear down the runtime (use only when a failed
 *   handler implies the session is unsafe to continue).
 */
export type ExtensionReactionFailureMode = "continue" | "isolate" | "halt"

/** Single reaction handler with explicit failure policy. */
export interface ExtensionReaction<Input, E = never, R = never> {
  readonly failureMode: ExtensionReactionFailureMode
  readonly handler: (input: Input, ctx: ExtensionHostContext) => Effect.Effect<void, E, R>
}

/**
 * The full reactions bag accepted by `defineExtension({ reactions })`. Every
 * field is optional; an extension that listens to nothing returns `{}` (or
 * omits the field).
 *
 * Type parameters `E`/`R` are erased to `unknown` at the bucket boundary —
 * the runtime reseals the failure channel at `runReaction` and the R channel
 * is closed at the declaration site (e.g. `Effect.provide(Layer)`).
 */
export interface ExtensionReactions<E = never, R = never> {
  /**
   * System-prompt rewrite. Receives the prompt string after static sections
   * and turn projections have been compiled, and returns the prompt to send
   * to the driver.
   */
  readonly systemPrompt?: (
    input: SystemPromptInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<string, E, R>
  /**
   * Turn-scoped prompt/tool-policy contribution. Use for read-only runtime
   * derivations that need current turn metadata plus services.
   */
  readonly turnProjection?: (ctx: ProjectionTurnContext) => Effect.Effect<TurnProjection, E, R>
  readonly turnBefore?: ExtensionReaction<TurnBeforeInput, E, R>
  readonly turnAfter?: ExtensionReaction<TurnAfterInput, E, R>
  readonly messageOutput?: ExtensionReaction<MessageOutputInput, E, R>
  /**
   * Tool-result rewrite. The handler receives the current result and returns
   * the next result; runs after the tool produces output and before downstream
   * consumers see it. Used for journaling, redaction, and structured-result
   * enrichment.
   */
  readonly toolResult?: (
    input: ToolResultInput,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<unknown, E, R>
}

// Extension State Machine — server-owned state that drives tool policy, prompt, and UI

export interface ExtensionReduceContext {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
}

export interface ExtensionTurnContext extends RunContext {
  readonly agent: AgentDefinition
  readonly allTools: ReadonlyArray<ToolToken>
}

/** Turn-scoped host + agent context used by prompt/tool-policy reactions. */
export interface ProjectionTurnContext {
  readonly sessionId: SessionId
  readonly branchId?: BranchId
  /** Process working directory (host cwd). */
  readonly cwd: string
  /** User home directory. */
  readonly home: string
  /** Session-scoped working directory, if the session was opened in a specific cwd. */
  readonly sessionCwd?: string
  readonly turn: ExtensionTurnContext
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
export const ExtensionEffectBusEmit = Schema.TaggedStruct("BusEmit", {
  channel: Schema.String,
  payload: Schema.Unknown,
})
export const ExtensionEffectSchema = ExtensionEffectBusEmit
export type ExtensionEffect = typeof ExtensionEffectBusEmit.Type

/** Result of a reducer/message handler call — always object form */
export interface ReduceResult<State> {
  readonly state: State
  readonly effects?: ReadonlyArray<ExtensionEffect>
}

/** Result of a request handler call — can reply and optionally transition state. */
export interface RequestResult<State, Reply> extends ReduceResult<State> {
  readonly reply: Reply
}

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
