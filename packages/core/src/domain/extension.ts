import type { Effect, FileSystem, Path } from "effect"
import { Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { GentPlatform, GentPlatformOsInfo } from "../runtime/gent-platform.js"
import type { AgentDefinition, AgentName } from "./agent"
import type { ToolCapability } from "./capability/tool.js"
import { ExtensionId, type BranchId, type SessionId, type ToolCallId } from "./ids"
import type { ExtensionContributions } from "./contribution.js"
export type { ExtensionContributions } from "./contribution.js"
import type { PromptSection } from "./prompt.js"
import type { ExtensionHost } from "./extension-host.js"

// Extension Manifest — authored by extension author

export interface ExtensionManifest {
  readonly id: ExtensionId
  readonly version?: string
}

/**
 * Stable identity supplied by the package or loader that produced an
 * extension artifact. This is never derived from a cached setup closure or a
 * current source-file read.
 */
export const LoadedArtifactIdentity = Schema.NonEmptyString.pipe(
  Schema.brand("LoadedArtifactIdentity"),
)
export type LoadedArtifactIdentity = typeof LoadedArtifactIdentity.Type

// Loaded Extension — manifest + derived metadata from loader

export interface LoadedExtension {
  readonly manifest: ExtensionManifest
  readonly scope: ExtensionScope
  readonly sourcePath: string
  /** Stable package/build identity. Missing means durable replay is unsupported. */
  readonly artifactIdentity?: LoadedArtifactIdentity
  /**
   * Typed contribution buckets produced by the extension's setup function.
   * Consumers (registries, workflow runtime, scheduler, lifecycle hooks,
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

export type ExtensionStatusInfo =
  | {
      readonly manifest: ExtensionManifest
      readonly scope: ExtensionScope
      readonly sourcePath: string
      readonly status: "active"
    }
  | ({
      readonly manifest: ExtensionManifest
      readonly scope: ExtensionScope
      readonly sourcePath: string
      readonly status: "failed"
    } & FailedExtension)

/** Scope precedence for extension resolution. Higher value = higher priority. */
export const SCOPE_PRECEDENCE = { builtin: 0, user: 1, project: 2 }
export type ExtensionScope = keyof typeof SCOPE_PRECEDENCE

/** Resolution order: scope precedence, then id. Later extensions win service conflicts. */
export const sortExtensionsByScope = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

// Extension Load Error

export class ExtensionLoadError extends Schema.TaggedError<ExtensionLoadError>(
  "@gent/core/src/domain/extension/ExtensionLoadError",
)("ExtensionLoadError", {
  extensionId: ExtensionId,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Run Context — per-run metadata for tool policy decisions

interface RunContext {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly parentToolCallId?: ToolCallId
  /** Whether this is an interactive session (human at the terminal).
   *  False for headless mode and subagent contexts. */
  readonly interactive?: boolean
}

// Turn-scoped input shapes for the explicit runtime seams. Prompt/context
// shaping, turn/message hooks, and tool-result enrichment live on hooks.

export interface SystemPromptInput {
  readonly basePrompt: string
  readonly agent: AgentDefinition
  readonly interactive?: boolean
  /**
   * Tools resolved for this turn. ACP-aware hooks need this to render
   * the codemode `gent.<tool>(...)` shape into the rewritten prompt.
   */
  readonly tools?: ReadonlyArray<ToolCapability>
  /** Admitted host tools, including tools hidden from the model by modelSet. */
  readonly hostTools?: ReadonlyArray<ToolCapability>
}

export interface TurnAfterInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly durationMs: number
  readonly agentName: AgentName
  readonly interrupted: boolean
  /**
   * The turn ended on a provider stream that broke and never recovered.
   *
   * A turn can end without an answer two ways, and they need different
   * handling: an interrupt is expected, a broken stream is a fault. Both facts
   * ride on this one input so a handler picks one action for the turn. A
   * handler that reads neither treats every turn alike, as before.
   *
   * The driver already retries a stream that breaks before any output, and the
   * loop already spends its continuations on one that breaks after partial
   * output. This is true only once both are exhausted.
   */
  readonly streamFailed: boolean
  /** Provider-reported tokens summed over every model call of the turn. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
}

// ── Lifecycle hooks ──
//
// Per-extension, per-session handlers run by the runtime at the prompt and
// turn seams. Authored on `defineExtension({ hooks })`.
// Failures are always isolated: the runtime logs a warning and lets later hooks
// still fire.

export type ExtensionHook<Input, Output, E = never, R = never> = {
  readonly handler: (input: Input) => Effect.Effect<Output, E, R>
}

/** Input and output of every runtime hook kind. `host.on(kind, handler)` is typed by this map. */
interface ExtensionHookSignatures {
  readonly systemPrompt: { readonly input: SystemPromptInput; readonly output: string }
  readonly turnProjection: { readonly input: void; readonly output: TurnProjection }
  readonly turnAfter: { readonly input: TurnAfterInput; readonly output: void }
}

export type ExtensionHookKind = keyof ExtensionHookSignatures

export type ExtensionHookHandler<K extends ExtensionHookKind, E = never, R = never> = (
  input: ExtensionHookSignatures[K]["input"],
) => Effect.Effect<ExtensionHookSignatures[K]["output"], E, R>

type ExtensionHookSlot<
  K extends ExtensionHookKind = ExtensionHookKind,
  E = never,
  R = never,
> = K extends ExtensionHookKind
  ? {
      readonly kind: K
      readonly hook: ExtensionHook<
        ExtensionHookSignatures[K]["input"],
        ExtensionHookSignatures[K]["output"],
        E,
        R
      >
    }
  : never

export type AnyExtensionHook = ExtensionHookSlot<ExtensionHookKind, never, never>

/**
 * Builds one hook slot. Author E/R are erased here: the runtime reseals
 * failures and provides extension services at every invocation.
 */
export const hook = <K extends ExtensionHookKind, E = never, R = never>(
  kind: K,
  handler: ExtensionHookHandler<K, E, R>,
): AnyExtensionHook =>
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Hook slots intentionally erase author error and service types at the runtime membrane.
  ({ kind, hook: { handler } }) as AnyExtensionHook

export interface ExtensionTurnContext extends RunContext {
  readonly agent: AgentDefinition
  readonly allTools: ReadonlyArray<ToolCapability>
}

/** Fragment contributed by an extension's derive() to influence tool visibility */
export interface ToolPolicyFragment {
  /** Tool names to force-include */
  readonly include?: ReadonlyArray<string>
  /** Tool names to force-exclude */
  readonly exclude?: ReadonlyArray<string>
  /** If set, replaces the full tool list (before agent deny reapplication) */
  readonly overrideSet?: ReadonlyArray<string>
  /**
   * Model-facing subset of the final admitted host tools. The last supplied set
   * wins. Missing, denied, and filtered interactive tools cannot be restored here.
   * An empty set advertises no tools. Omission preserves the previous selection.
   */
  readonly modelSet?: ReadonlyArray<string>
}

/** Turn-time projection — needs agent/tool context, used during prompt assembly */
export interface TurnProjection {
  readonly toolPolicy?: ToolPolicyFragment
  readonly promptSections?: ReadonlyArray<PromptSection>
}

// `ProviderAuthInfo` is declared in driver.ts and reaches the model registry
// through this module, beside the extension surface that uses it.
export type { ProviderAuthInfo } from "./driver.js"
import type { ProcessResult, RunProcessOptions } from "../runtime/run-process.js"

// Extension — the core primitive

export class ExtensionHostProcessError extends Schema.TaggedError<ExtensionHostProcessError>()(
  "ExtensionHostProcessError",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    timedOut: Schema.optional(Schema.Boolean),
  },
) {}

export interface ExtensionHostFacts {
  readonly osInfo: GentPlatformOsInfo
  readonly execPath: string
  readonly homeDirectory: string
  readonly pathListSeparator: string
}

export interface ExtensionHostPlatform extends ExtensionHostFacts {
  // oxlint-disable-next-line effect/noNullish -- Process environment maps preserve absent variables at the host boundary.
  readonly parentEnv: Record<string, string | undefined>
  readonly randomId: Effect.Effect<string>
  readonly runProcess: (
    command: string,
    args: ReadonlyArray<string>,
    options?: RunProcessOptions,
  ) => Effect.Effect<ProcessResult, ExtensionHostProcessError>
}

/** Platform services the loader itself runs against. */
export type ExtensionLoaderServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | GentPlatform

/** Services available to every `setup` Effect: the loader platform plus the registration host. */
export type ExtensionSetupServices = ExtensionLoaderServices | ExtensionHost

export interface GentExtension<R = ExtensionSetupServices> {
  readonly manifest: ExtensionManifest
  /** Stable package/build identity. Missing means durable replay is unsupported. */
  readonly artifactIdentity?: LoadedArtifactIdentity
  /**
   * Registers the extension's leaves and hooks through `yield* ExtensionHost`.
   * The loader provides the host, collects the registrations, validates them,
   * and stores the sealed record on `LoadedExtension.contributions`.
   */
  readonly setup: Effect.Effect<void, ExtensionLoadError, R>
}
