import type { Context, Duration, Effect } from "effect"
import { Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { AgentDefinition, AgentName, DriverSource } from "./agent"
import type { ToolCapability } from "./capability/tool.js"
import { ExtensionId, type BranchId, type SessionId, type ToolCallId } from "./ids"
import type { ExtensionContributions } from "./contribution.js"
export type { ExtensionContributions } from "./contribution.js"
import type { PromptSection } from "./prompt.js"

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
   * `contributions.requests`, `contributions.resources`, etc. The bucket name IS the discrimination;
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
      readonly scheduledJobFailures?: ReadonlyArray<ScheduledJobFailureInfo>
    }
  | ({
      readonly manifest: ExtensionManifest
      readonly scope: ExtensionScope
      readonly sourcePath: string
      readonly status: "failed"
      readonly scheduledJobFailures?: ReadonlyArray<ScheduledJobFailureInfo>
    } & FailedExtension)

/** Scope precedence for extension resolution. Higher value = higher priority. */
export const SCOPE_PRECEDENCE = { builtin: 0, user: 1, project: 2 } as const
export type ExtensionScope = keyof typeof SCOPE_PRECEDENCE

// Extension Load Error

export class ExtensionLoadError extends Schema.TaggedErrorClass<ExtensionLoadError>(
  "@gent/core-internal/domain/extension/ExtensionLoadError",
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
// shaping, turn/message hooks, and tool-result enrichment live on reactions.

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
  readonly tools?: ReadonlyArray<ToolCapability>
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
  readonly input: unknown
  readonly result: unknown
  readonly agentName?: AgentName
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

// ── Lifecycle reactions ──
//
// Per-extension, per-session handlers run by the runtime at the
// `turnAfter` / `toolResult` seams.  Authored on
// `defineExtension({ reactions })`. Failures are always isolated: the
// runtime logs a warning and lets later reactions still fire.

/** Single reaction handler. Failures are isolated (logged, then swallowed). */
export type ExtensionReaction<Input, E = never, R = never> = {
  readonly handler: (input: Input) => Effect.Effect<void, E, R>
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
  readonly systemPrompt?: (input: SystemPromptInput) => Effect.Effect<string, E, R>
  /**
   * Turn-scoped prompt/tool-policy contribution. Use for read-only runtime
   * derivations that need current turn metadata plus services.
   */
  readonly turnProjection?: () => Effect.Effect<TurnProjection, E, R>
  readonly turnAfter?: ExtensionReaction<TurnAfterInput, E, R>
  /**
   * Tool-result rewrite. The handler receives the current result and returns
   * the next result; runs after the tool produces output and before downstream
   * consumers see it. Used for journaling, redaction, and structured-result
   * enrichment.
   */
  readonly toolResult?: (input: ToolResultInput) => Effect.Effect<unknown, E, R>
}

export interface ExtensionTurnContext extends RunContext {
  readonly agent: AgentDefinition
  readonly allTools: ReadonlyArray<ToolCapability>
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
  readonly capabilityContext?: Context.Context<never>
  readonly turn: ExtensionTurnContext
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

// Turn executor types — owned by the driver primitive (external drivers wrap them).
export type { TurnExecutor, TurnContext, TurnStreamPart, TurnError } from "./driver.js"

// Driver auth + hint shared types — re-exported from dedicated file
//
// Lives in driver.ts now. Re-exported here so existing internal consumers keep
// their import paths through `domain/extension.js`.

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
  /** User home directory (e.g. ~/.gent lives here). Defaults to the platform home directory. */
  readonly home: string
  readonly host: ExtensionHostPlatform
}

export interface ExtensionHostOsInfo {
  readonly platform: string
  readonly arch: string
  readonly release: string
  readonly hostname: string
  readonly type: string
}

export type ExtensionHostSignal = string | 0

export class ExtensionHostProcessError extends Schema.TaggedErrorClass<ExtensionHostProcessError>()(
  "ExtensionHostProcessError",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
    timedOut: Schema.optional(Schema.Boolean),
  },
) {}

export interface ExtensionHostProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ExtensionHostRunProcessOptions {
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly timeout?: Duration.Duration
  readonly stdin?: "pipe" | "ignore" | "inherit"
  readonly stdout?: "pipe" | "ignore" | "inherit"
  readonly stderr?: "pipe" | "ignore" | "inherit"
}

export interface ExtensionHostFacts {
  readonly osInfo: ExtensionHostOsInfo
  readonly execPath: string
  readonly homeDirectory: string
  readonly pathListSeparator: string
  readonly commandCandidates: (command: string) => ReadonlyArray<string>
  readonly isPortFree: (port: number) => Effect.Effect<boolean>
  readonly isPidAlive: (pid: number) => Effect.Effect<boolean>
}

export interface ExtensionHostPlatform extends ExtensionHostFacts {
  readonly parentEnv: Record<string, string | undefined>
  readonly signalPid: (pid: number, signal: ExtensionHostSignal) => Effect.Effect<void>
  readonly runProcess: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ExtensionHostRunProcessOptions,
  ) => Effect.Effect<ExtensionHostProcessResult, ExtensionHostProcessError>
}

export interface GentExtension<R = ChildProcessSpawner> {
  readonly manifest: ExtensionManifest
  /**
   * Returns the typed `ExtensionContributions` buckets for this extension.
   * The runtime stores this directly on `LoadedExtension.contributions`;
   * consumers read each bucket as a typed array. There is no flat
   * `Contribution[]` and no core `_kind` discriminator.
   */
  readonly setup: (
    ctx: ExtensionSetupContext,
  ) => Effect.Effect<ExtensionContributions, ExtensionLoadError, R>
}

// Legacy keyed middleware primitives are gone. Prompt/context shaping,
// turn/message hooks, and tool-result enrichment live on reactions.
