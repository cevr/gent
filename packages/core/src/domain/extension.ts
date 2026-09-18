import {
  Context,
  Effect,
  type FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  TxRef,
  TxSemaphore,
} from "effect"
import {
  type AgentDefinition,
  type AgentName,
  type AgentRunError,
  type AgentRunResult,
  type ChildAgentRegistryEntry,
  DEFAULT_AGENT_NAME,
  type RunSpec,
  type SessionDepthLimitError,
} from "./agent.js"
import {
  getToolId,
  getToolMetadata,
  isToolCapability,
  type PromptSection,
  type RequestCapability,
  type ToolCapability,
} from "./capability.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "./driver.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type {
  GentPlatform,
  GentPlatformOsInfo,
  ProcessResult,
  RunProcessOptions,
} from "../runtime/gent-platform.js"
import {
  type BranchId,
  ExtensionId,
  type RequestId,
  type SessionId,
  type ToolCallId,
} from "./ids.js"
import type { AgentEvent, EventStoreError, TurnCompleted } from "./event.js"
import { causeMessage } from "./guards.js"
import type { ApprovalDecision, ApprovalRequest, InteractionPendingError } from "./interaction.js"
import type { Branch, Message, MessageMetadata, Session } from "./message.js"
import type { InvalidStateError, NotFoundError, StorageError } from "./errors.js"
import type { SessionRuntimeError } from "../runtime/session.js"
import type {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  SessionSettings,
  SwitchBranchInput,
  UpdateSessionSettingsInput,
} from "../server/rpc.js"

// ── resource ────────────────────────────────────────────────────────────────

/**
 * Resource — long-lived state with explicit scope.
 *
 * One primitive carries the whole concept: "this extension owns a long-lived
 * service with optional startup/shutdown."
 *
 * The `scope` discriminator is intentionally narrow. The host owns two
 * long-lived resource lifetimes:
 *
 *   - `"process"` — survives for the server's lifetime; requires `ServerScope`
 *   - `"branch"`  — survives for one agent-loop branch; requires `BranchScope`
 *
 * Add a scope literal only together with its host lifecycle implementation.
 * Advertising `session`/`cwd` without a runtime owner makes impossible
 * lifetimes look supported.
 *
 * @module
 */

/** Stable identity for a declared resource. */
export const ResourceId = Schema.NonEmptyString.pipe(Schema.brand("ResourceId"))
export type ResourceId = typeof ResourceId.Type

// ── Scope discriminator + brand mapping ──

/**
 * Pure type-level scope brand used by Resource declarations. Encodes the
 * lifetime of a `Scope.Scope` at the type level. `ServerScope` survives for the
 * server's lifetime. Add new brands only when their resource host lifecycle
 * exists. These types carry no runtime payload; they are purely structural.
 */
declare const ServerBrand: unique symbol
type ServerScope = { readonly [ServerBrand]: true }

/**
 * One agent-loop branch's lifetime. The actor forks a child of its own scope
 * per loop rebuild and transfers it to the published loop handle, so a branch
 * resource is released when that branch closes.
 */
declare const BranchBrand: unique symbol
type BranchScope = { readonly [BranchBrand]: true }

/** Runtime literal-string union for Resource lifetimes. */
export type ResourceScope = "process" | "branch"

/**
 * Type-level mapping from the `scope` literal to the corresponding nominal
 * scope brand. The brand flows into the `R` channel of the Resource's `layer`.
 */
type ScopeOf<S extends ResourceScope> = S extends "process"
  ? ServerScope
  : S extends "branch"
    ? BranchScope
    : never

// ── The Resource contribution ──

/**
 * One Resource carries:
 *
 * - `id` — stable identity, reported when the resource fails to build.
 * - `tag` + `layer` — the canonical Layer providing one or more services.
 *   The `R` channel must include `ScopeOf<S>` so the typed scope brand
 *   gates instantiation.
 * - `scope` — the lifetime, declared at the type level via the literal.
 * - `start` / `stop` — optional startup + shutdown effects.
 *   `stop` is `Effect<void, never, A>` per Effect finalizer contract — it
 *   may not fail (failures are not propagated through scope teardown).
 * - `runtime` — explicit runtime slots for long-lived behavior that reacts
 *   to turns/messages or enriches tool results without going through a
 *   string-keyed middleware registry.
 *
 * Authors typically create a Resource through the smart constructor
 * `defineResource(...)`. The `tag` is the canonical entry into the service
 * the Resource provides; consumers depend on the tag, not on Resource.
 */
interface ResourceContribution<A, S extends ResourceScope, R = never, E = never, StartR = never> {
  readonly id: ResourceId
  /**
   * Optional canonical service tag. When present, consumers may depend on the
   * tag without knowing about Resource. The `start`/`stop` effects get `A`
   * in their R channel so they can read the owned service.
   *
   * When absent, the Resource is a pure layer contribution (the `layer` may
   * provide multiple services via `Layer.merge(...)`), and the lifecycle
   * effects have `A = never` in their R channel.
   *
   * Effect v4 `Context.Service<Identity, Service>` produces a tag whose
   * identity (`A`) and service interface differ; this is why we use the
   * 2-parameter `Context.Key<I, S>` shape instead of the 1-parameter
   * `Context.Tag<A>` shape.
   */
  readonly tag?: Context.Key<A, unknown>
  readonly scope: S
  readonly layer: Layer.Layer<A, E, R | ScopeOf<S>>
  readonly start?: Effect.Effect<void, E, A | R | StartR>
  readonly stop?: Effect.Effect<void, never, A>
}

/**
 * Heterogeneous Resource type — used in arrays where the Resource set
 * spans multiple service tags + R/E channels. Hosts iterate this shape and
 * route each Resource to the appropriate engine.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
export type AnyResourceContribution = ResourceContribution<any, ResourceScope, any, any, any>

interface ResourceIdentitySpec {
  /** Stable resource identity. */
  readonly id: string
}

// ── Smart constructor ──

/**
 * Spec type accepted by {@link defineResource}. Uses `NoInfer` on the
 * `tag` field so the identity `A` is inferred from `layer` only — passing
 * a tag for a different service identity is then a type error rather
 * than a silent unification of `A` to a union supertype.
 */
interface ResourceSpec<
  A,
  S extends ResourceScope,
  R = never,
  E = never,
  StartR = never,
> extends ResourceIdentitySpec {
  readonly tag?: Context.Key<NoInfer<A>, unknown>
  readonly scope: S
  readonly layer: Layer.Layer<A, E, R | ScopeOf<S>>
  /**
   * `StartR` is the additional services `start` may yield beyond the
   * resource's own service `A` and the layer's `R`. Useful when the
   * lifecycle action needs runtime services provided by sibling base
   * layers without forcing the resource's layer
   * itself to depend on them.
   */
  readonly start?: Effect.Effect<void, E, NoInfer<A> | R | StartR>
  readonly stop?: Effect.Effect<void, never, NoInfer<A>>
}

/**
 * Author-facing factory for a {@link ResourceContribution}.
 *
 * The factory infers the generics from the inputs (so authors don't write
 * `<MyService, "process", never, never>`) and brands the resource id.
 *
 * Identity `A` is inferred from `layer`. The `tag` field, if present, is
 * typed as `Context.Key<NoInfer<A>, unknown>` — it must match the layer's
 * identity exactly. Passing a tag for a different service is a type error.
 */
export const defineResource = <A, S extends ResourceScope, R = never, E = never, StartR = never>(
  spec: ResourceSpec<A, S, R, E, StartR>,
): ResourceContribution<A, S, R, E, StartR> => {
  const { id, ...resource } = spec
  return { ...resource, id: ResourceId.make(id) }
}

// ── contribution ────────────────────────────────────────────────────────────

/**
 * Contribution buckets — typed sub-arrays for `defineExtension`.
 *
 * Extensions declare their leaf values in homogeneously typed buckets. The
 * bucket name IS the discrimination — no `_kind` field on leaves, no wrapper
 * smart constructors, no `filterByKind`.
 *
 * Capabilities are authored through the typed factories `tool({...})` and
 * `request({...})` at `domain/capability/{tool,request}.ts`. Slash commands
 * are requests carrying a `slash:` presentation block.
 *
 * Resources are authored through `defineResource({...})` from
 * `./resource.ts`. Each leaf carries an
 * explicit stable resource identity and graph metadata; the leaf is widened
 * by structural assignability at the bucket boundary.
 *
 * Drivers split into `modelDrivers` and `externalDrivers`; one untagged
 * `drivers: []` bucket would erase the correlated union.
 *
 * @module
 */

// ── Typed buckets ──

/**
 * The set of buckets an extension may contribute to. Every field is optional;
 * an extension that contributes nothing returns `{}`. Each bucket is
 * homogeneously typed — there is no discriminator, the field name is the
 * discrimination.
 *
 * Driver split: `modelDrivers` / `externalDrivers` are separate buckets. They
 * share `id` (driver registry key) but nothing else, so a single `drivers`
 * bucket would re-introduce the union-shape unsoundness that the correlated
 * `DriverKindContribution` fixed.
 */
export interface ExtensionContributions {
  readonly resources?: ReadonlyArray<AnyResourceContribution>
  /**
   * LLM-callable tools authored via `tool({...})`. Bucket name IS the
   * dispatch surface: every entry is a `ToolCapability` — no runtime tag check
   * needed downstream.
   */
  readonly tools?: ReadonlyArray<ToolCapability>
  /**
   * Extension-to-extension RPC capabilities authored via `request({...})`.
   * Bucket name IS the dispatch surface: every entry is a `RequestCapability` — no
   * runtime tag check needed downstream. Slash commands are requests carrying
   * a `slash:` presentation block.
   */
  readonly requests?: ReadonlyArray<RequestCapability>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly hooks?: ReadonlyArray<AnyExtensionHook>
  readonly modelDrivers?: ReadonlyArray<ModelDriverContribution>
  readonly externalDrivers?: ReadonlyArray<ExternalDriverContribution>
}

// ── Smart constructors ──
//
// Capabilities are authored through the typed factories in
// `domain/capability/{tool,request}.ts`. The Resource primitive is authored
// through `defineResource({...})` directly — leaves widen to
// `AnyResourceContribution` by structural assignability when the `layer`'s
// `A` is concrete (not `never`). Lifecycle-only resources should
// encode disposal as a `Layer.scoped` finalizer over a marker tag rather than
// `{ layer: Layer.empty, stop: ... }`.

// ── extension ───────────────────────────────────────────────────────────────

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

/**
 * Whether a discovered file belongs to the client rather than the host.
 *
 * The host loader and the TUI discoverer scan the same directories and must
 * agree on which files each one owns: a file both claim is loaded twice, and a
 * file neither claims is never loaded. One predicate, read by both.
 *
 * Matches `*.client.{ts,tsx,js,jsx,mjs}` and a directory's `client.*` entry.
 */
export const isClientFile = (entry: string): boolean =>
  /\.client\.(?:[tj]sx?|mjs)$/.test(entry) || isClientEntrypoint(entry)

/**
 * Whether a directory entry is that directory's client entrypoint.
 *
 * A directory extension names its client half `client.*`. More than one match
 * is ambiguous, so the discoverer picks the first by name and says so.
 */
export const isClientEntrypoint = (entry: string): boolean =>
  /^client\.(?:[tj]sx?|mjs)$/.test(entry)

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

type ExtensionHookKind = keyof ExtensionHookSignatures

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

interface ExtensionHostFacts {
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

// ── extension-host ──────────────────────────────────────────────────────────

/**
 * `ExtensionHost` — the one service an extension's `setup` yields.
 *
 * It carries the setup-time facts (cwd, source, home, host facts, process
 * helpers) and the two registration primitives:
 *
 * - `register(domain, ...values)` adds typed leaves to one registration
 *   domain: tools, requests, agents, resources, jobs, model or external drivers.
 * - `on(kind, handler)` adds one runtime hook.
 *
 * The loader provides the service around `GentExtension.setup`, collects the
 * registrations, validates them, and seals them into
 * `LoadedExtension.contributions`. There is no ctx parameter and no bucket
 * literal: authors yield the host inside `setup`.
 *
 * @module
 */

/** Author-facing domain name → contribution bucket it lands in. */
interface RegistrationDomainMap {
  readonly tool: "tools"
  readonly request: "requests"
  readonly agent: "agents"
  readonly resource: "resources"
  readonly modelDriver: "modelDrivers"
  readonly externalDriver: "externalDrivers"
}

const registrationDomains: RegistrationDomainMap = {
  tool: "tools",
  request: "requests",
  agent: "agents",
  resource: "resources",
  modelDriver: "modelDrivers",
  externalDriver: "externalDrivers",
}

type RegistrationDomain = keyof typeof registrationDomains
type BucketOf<D extends RegistrationDomain> = RegistrationDomainMap[D]
type ElementOf<A> = A extends ReadonlyArray<infer Item> ? Item : never
type RegistrationValue<D extends RegistrationDomain> = ElementOf<
  NonNullable<ExtensionContributions[BucketOf<D>]>
>

export interface ExtensionHostService {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: Pick<
    ExtensionHostPlatform,
    "osInfo" | "execPath" | "homeDirectory" | "pathListSeparator"
  >
  readonly Process: Pick<ExtensionHostPlatform, "parentEnv" | "runProcess">
  /** Registers leaves in one typed domain. Order within a domain is kept. */
  readonly register: <D extends RegistrationDomain>(
    domain: D,
    ...values: ReadonlyArray<RegistrationValue<D>>
  ) => Effect.Effect<void>
  /** Registers one runtime hook. Author error and service channels are sealed by the runtime. */
  readonly on: <K extends ExtensionHookKind, E = never, R = never>(
    kind: K,
    handler: ExtensionHookHandler<K, E, R>,
  ) => Effect.Effect<void>
}

export class ExtensionHost extends Context.Service<ExtensionHost, ExtensionHostService>()(
  "@gent/core/src/domain/extension/ExtensionHost",
) {}

interface CollectingHostFacts {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: ExtensionHostPlatform
}

type MutableContributions = {
  -readonly [K in keyof ExtensionContributions]?: Array<
    ElementOf<NonNullable<ExtensionContributions[K]>>
  >
}

/**
 * A host whose registrations accumulate into one contributions record.
 * `seal` returns the record with empty buckets dropped.
 */
interface CollectingExtensionHost {
  readonly service: ExtensionHostService
  readonly seal: Effect.Effect<ExtensionContributions>
}

export const makeCollectingExtensionHost = (
  facts: CollectingHostFacts,
): CollectingExtensionHost => {
  const collected: MutableContributions = {}
  const push = <K extends keyof ExtensionContributions>(
    bucket: K,
    values: ReadonlyArray<ElementOf<NonNullable<ExtensionContributions[K]>>>,
  ) => {
    if (values.length === 0) return
    const current = collected[bucket] ?? []
    // The bucket arrays are homogeneous by construction; TypeScript loses the
    // correlation between `bucket` and its element type across the index.
    // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Correlated bucket/element pair is guaranteed by the K parameter.
    collected[bucket] = [...current, ...values] as MutableContributions[K]
  }
  const service: ExtensionHostService = {
    cwd: facts.cwd,
    source: facts.source,
    home: facts.home,
    host: {
      osInfo: facts.host.osInfo,
      execPath: facts.host.execPath,
      homeDirectory: facts.host.homeDirectory,
      pathListSeparator: facts.host.pathListSeparator,
    },
    Process: {
      parentEnv: facts.host.parentEnv,
      runProcess: facts.host.runProcess,
    },
    register: (domain, ...values) =>
      Effect.sync(() => {
        push(registrationDomains[domain], values)
      }),
    on: (kind, handler) =>
      Effect.sync(() => {
        push("hooks", [hook(kind, handler)])
      }),
  }
  // `push` replaces bucket arrays instead of mutating them, so a shallow copy
  // is a stable snapshot; empty buckets never enter `collected`.
  return { service, seal: Effect.sync((): ExtensionContributions => ({ ...collected })) }
}

/** Re-registers one compiled slot; the switch restores the kind/handler correlation. */
const replayHook = (host: ExtensionHostService, slot: AnyExtensionHook): Effect.Effect<void> => {
  switch (slot.kind) {
    case "systemPrompt":
      return host.on(slot.kind, slot.hook.handler)
    case "turnProjection":
      return host.on(slot.kind, slot.hook.handler)
    case "turnAfter":
      return host.on(slot.kind, slot.hook.handler)
  }
}

/** Re-registers an already compiled record; used by test harnesses that wrap loaded extensions. */
export const registerContributions = (contributions: ExtensionContributions) =>
  Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", ...(contributions.resources ?? []))
    yield* host.register("tool", ...(contributions.tools ?? []))
    yield* host.register("request", ...(contributions.requests ?? []))
    yield* host.register("agent", ...(contributions.agents ?? []))
    yield* host.register("modelDriver", ...(contributions.modelDrivers ?? []))
    yield* host.register("externalDriver", ...(contributions.externalDrivers ?? []))
    for (const slot of contributions.hooks ?? []) yield* replayHook(host, slot)
  })

// ── extension-services ──────────────────────────────────────────────────────

export class ExtensionServiceError extends Schema.TaggedError<ExtensionServiceError>()(
  "@gent/core/src/domain/extension/ExtensionServiceError",
  {
    service: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const extensionServiceError =
  (service: string, operation: string) =>
  (cause: unknown): ExtensionServiceError =>
    new ExtensionServiceError({
      service,
      operation,
      message: causeMessage(cause),
      cause,
    })

/** Restates a facet failure as the one error extensions see. */
export const mapExtensionServiceError = <A, E, R>(
  service: string,
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ExtensionServiceError, R> =>
  effect.pipe(Effect.mapError(extensionServiceError(service, operation)))

export interface ExtensionSessionService {
  readonly getSession: (
    sessionId?: SessionId,
  ) => // oxlint-disable-next-line effect/noNullish -- The public extension facade preserves undefined for an absent session.
  Effect.Effect<Session | undefined, ExtensionServiceError>
  readonly getDetail: (sessionId: SessionId) => Effect.Effect<
    {
      readonly session: Session
      readonly branches: ReadonlyArray<{
        readonly branch: Branch
        readonly messages: ReadonlyArray<Message>
      }>
    },
    ExtensionServiceError
  >
  readonly renameCurrent: (
    name: string,
  ) => Effect.Effect<{ readonly renamed: boolean; readonly name?: string }, ExtensionServiceError>
  readonly queueFollowUp: (params: {
    readonly sourceId: string
    readonly content: string
    readonly metadata?: MessageMetadata
    readonly branchId?: BranchId
    readonly wake?: boolean
  }) => Effect.Effect<void, ExtensionServiceError>
  /** Removes a queued follow-up by source. False when absent or already running. */
  readonly dequeueFollowUp: (params: {
    readonly sourceId: string
    readonly branchId?: BranchId
  }) => Effect.Effect<boolean, ExtensionServiceError>
  readonly listBranches: Effect.Effect<ReadonlyArray<Branch>, ExtensionServiceError>
  /**
   * Every session in the workspace. The durable half of an agent catalog:
   * survives restarts, but says nothing about what is running now.
   */
  readonly listSessions: Effect.Effect<ReadonlyArray<Session>, ExtensionServiceError>
  /**
   * Loops materialized right now. The live half of an agent catalog: carries
   * status, but is empty after a restart and omits idle or evicted branches.
   * Merge against `listSessions` to see every agent rather than only the
   * running ones.
   */
  readonly listActiveLoops: Effect.Effect<
    ReadonlyArray<{
      readonly sessionId: SessionId
      readonly branchId: BranchId
      /** Runtime state tag such as `Idle` or `Running`; `None` when the read failed. */
      readonly status: Option.Option<string>
    }>,
    ExtensionServiceError
  >
}

interface ExtensionAgentStartParams {
  readonly agent: AgentDefinition
  readonly prompt: string
  readonly requestId: RequestId
  readonly cwd?: string
  readonly runSpec?: RunSpec
}

interface ExtensionAgentRunParams {
  readonly agent: AgentDefinition
  readonly prompt: string
  readonly cwd?: string
  readonly runSpec?: RunSpec
  /** Sees child events in order as they happen, private runs included. Best effort: the run result can return before trailing events are observed, so read the answer from the result. Ephemeral runs only. */
  readonly observe?: (event: AgentEvent) => Effect.Effect<void>
}

interface ExtensionAgentService {
  readonly listAgents: Effect.Effect<ReadonlyArray<AgentDefinition>, ExtensionServiceError>
  /** Start from a host-owned tool call. The host supplies parent and tool identity. */
  readonly start: (
    params: ExtensionAgentStartParams,
  ) => Effect.Effect<
    { readonly sessionId: SessionId; readonly branchId: BranchId },
    AgentRunError | ExtensionServiceError
  >
  readonly inspect: (params: { readonly requestId: RequestId }) => Effect.Effect<
    {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly completion: Option.Option<TurnCompleted>
    },
    AgentRunError
  >
  readonly list: () => Effect.Effect<ReadonlyArray<ChildAgentRegistryEntry>, AgentRunError>
  readonly cancel: (params: { readonly requestId: RequestId }) => Effect.Effect<void, AgentRunError>
  /** Message a child that is still running. `sendId` makes a replayed call deliver once. */
  readonly send: (params: {
    readonly requestId: RequestId
    readonly message: string
    readonly sendId: RequestId
  }) => Effect.Effect<void, AgentRunError>
  readonly run: (
    params: ExtensionAgentRunParams,
  ) => Effect.Effect<AgentRunResult, AgentRunError | ExtensionServiceError>
}

/** The host's agent facet. `start` still needs the tool call the child is owned by. */
export interface ExtensionHostAgentService extends Omit<ExtensionAgentService, "start"> {
  readonly start: (
    params: ExtensionAgentStartParams & { readonly toolCallId: ToolCallId },
  ) => Effect.Effect<
    { readonly sessionId: SessionId; readonly branchId: BranchId },
    AgentRunError | ExtensionServiceError
  >
}

export interface ExtensionInteractionService {
  readonly approve: (
    params: ApprovalRequest,
  ) => Effect.Effect<ApprovalDecision, ExtensionServiceError | InteractionPendingError>
  readonly present: (params: {
    readonly content: string
    readonly title?: string
  }) => Effect.Effect<void, ExtensionServiceError | InteractionPendingError>
}

export interface ExtensionProcessService {
  readonly randomId: Effect.Effect<string>
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: RunProcessOptions,
  ) => Effect.Effect<ProcessResult, ExtensionServiceError>
  // oxlint-disable-next-line effect/noNullish -- Process environment maps preserve absent variables at the host boundary.
  readonly parentEnv: Record<string, string | undefined>
}

interface ExtensionFileStat {
  readonly type:
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"
  readonly size: bigint
  // oxlint-disable-next-line effect/noNullish -- File stat preserves the platform's absent modification time.
  readonly mtime: Date | undefined
}

export interface ExtensionFilesService {
  readonly read: (path: string) => Effect.Effect<string, ExtensionServiceError>
  readonly write: (
    path: string,
    content: string,
    options?: { readonly atomic?: boolean },
  ) => Effect.Effect<void, ExtensionServiceError>
  readonly exists: (path: string) => Effect.Effect<boolean, ExtensionServiceError>
  readonly stat: (path: string) => Effect.Effect<ExtensionFileStat, ExtensionServiceError>
  readonly makeDirectory: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ) => Effect.Effect<void, ExtensionServiceError>
  readonly resolve: (...paths: ReadonlyArray<string>) => string
  readonly join: (...paths: ReadonlyArray<string>) => string
  readonly dirname: (path: string) => string
}

export interface ExtensionFileLockServiceApi {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

interface ExtensionStateServiceApi {
  readonly changed: () => Effect.Effect<void, ExtensionServiceError>
}

/**
 * The run's half of the state facet: it knows the session and branch, and
 * takes the extension id from whichever leaf reports the change.
 */
export type ExtensionStateFacet = (
  extensionId: Option.Option<ExtensionId>,
) => ExtensionStateServiceApi

/**
 * Every facet, built once per run by the provider that owns its inputs.
 * A leaf adds only the two facts a run does not carry: the tool call
 * `Agent.start` charges a child to, and the extension id `State.changed`
 * reports under.
 */
export interface ExtensionHostContext {
  readonly extensionId?: ExtensionId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly cwd: string
  readonly home: string
  readonly host: ExtensionHostPlatform
  readonly Agent: ExtensionHostAgentService
  readonly Session: ExtensionSessionService
  readonly Interaction: ExtensionInteractionService
  readonly Process: ExtensionProcessService
  readonly Files: ExtensionFilesService
  readonly FileLock: ExtensionFileLockServiceApi
  /** Reports under the leaf's extension id, which a run does not know. */
  readonly State: ExtensionStateFacet
}

export interface ExtensionContextService {
  readonly extensionId: ExtensionId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  readonly toolCallId?: ToolCallId
  readonly turn?: ExtensionTurnContext
  readonly cwd: string
  readonly home: string
  readonly Session: ExtensionSessionService
  readonly Agent: ExtensionAgentService
  readonly Interaction: ExtensionInteractionService
  readonly Process: ExtensionProcessService
  readonly Files: ExtensionFilesService
  readonly FileLock: ExtensionFileLockServiceApi
  readonly State: ExtensionStateServiceApi
}

export class ExtensionContext extends Context.Service<ExtensionContext, ExtensionContextService>()(
  "@gent/core/src/domain/extension/ExtensionContext",
) {}

/**
 * The per-leaf half of the extension context: the run's facets, plus the two
 * facts only a leaf knows. `Agent.start` charges the child to the leaf's tool
 * call, and `State.changed` reports under the leaf's extension id. Every other
 * facet is forwarded, because the run already built it over the services that
 * own its inputs.
 */
const extensionServicesFromHostContext = (
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
): Context.Context<ExtensionContext> => {
  const Agent: ExtensionAgentService = {
    ...ctx.Agent,
    start: Effect.fn("ExtensionAgent.start")(function* (params) {
      if (Predicate.isUndefined(ctx.toolCallId)) {
        return yield* new ExtensionServiceError({
          service: "ExtensionAgent",
          operation: "start",
          message: "Child start requires a host-owned tool call",
        })
      }
      return yield* ctx.Agent.start({ ...params, toolCallId: ctx.toolCallId })
    }),
  }
  const extensionIdOption = Option.fromUndefinedOr(ctx.extensionId)
  return Context.empty().pipe(
    Context.add(ExtensionContext, {
      extensionId: Option.getOrElse(extensionIdOption, () => ExtensionId.make("unknown")),
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      agentName: ctx.agentName,
      toolCallId: ctx.toolCallId,
      turn: ctx.turn,
      cwd: ctx.cwd,
      home: ctx.home,
      Session: ctx.Session,
      Agent,
      Interaction: ctx.Interaction,
      Process: ctx.Process,
      Files: ctx.Files,
      FileLock: ctx.FileLock,
      State: ctx.State(extensionIdOption),
    }),
  )
}

export const provideExtensionServices = <A, E, R>(
  ctx: ExtensionHostContext & {
    readonly toolCallId?: ToolCallId
    readonly turn?: ExtensionTurnContext
  },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ExtensionContext>> =>
  effect.pipe(Effect.provideContext(extensionServicesFromHostContext(ctx)))

/**
 * The agent running the current turn. Children spawned from a cell inherit
 * it, so delegation never needs a roster of named agents.
 */
export const requireCurrentAgent: Effect.Effect<
  AgentDefinition,
  ExtensionServiceError,
  ExtensionContext
> = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const name = Option.getOrElse(Option.fromUndefinedOr(ctx.agentName), () => DEFAULT_AGENT_NAME)
  const agents = yield* ctx.Agent.listAgents
  const agent = agents.find((a) => a.name === name)
  if (!Predicate.isUndefined(agent)) return agent
  return yield* new ExtensionServiceError({
    service: "ExtensionAgent",
    operation: "require",
    message: `Agent "${name}" not found in registry`,
  })
})

// ── extension-load-boundary ─────────────────────────────────────────────────

const toExtensionLoadError = (opts: {
  readonly extensionId: ExtensionId
  readonly message: string
  readonly cause: unknown
}): ExtensionLoadError => {
  if (Schema.is(ExtensionLoadError)(opts.cause)) {
    return opts.cause
  }
  return new ExtensionLoadError({
    extensionId: opts.extensionId,
    message: opts.message,
    cause: opts.cause,
  })
}

export const sealRuntimeLoadedEffect = <A, R = never>(opts: {
  readonly extensionId: ExtensionId
  readonly effect: () => Effect.Effect<A, unknown, R>
  readonly failureMessage: (cause: unknown) => string
  readonly defectMessage: (cause: unknown) => string
}): Effect.Effect<A, ExtensionLoadError, R> => {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const sealed = Effect.suspend(opts.effect).pipe(
    Effect.catchEager((cause) =>
      Effect.fail(
        toExtensionLoadError({
          extensionId: opts.extensionId,
          message: opts.failureMessage(cause),
          cause,
        }),
      ),
    ),
    Effect.catchDefect((cause) =>
      Effect.fail(
        toExtensionLoadError({
          extensionId: opts.extensionId,
          message: opts.defectMessage(cause),
          cause,
        }),
      ),
    ),
  )
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- The load membrane re-seals the extension effect after normalizing its failure channel.
  return sealed as Effect.Effect<A, ExtensionLoadError, R> // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
}

// ── extension-package-shape ─────────────────────────────────────────────────

/**
 * Cross-bucket validation shared by `defineExtension` and runtime-loaded
 * extension packages. Field-local messages beat opaque shape failures.
 */

const checkBucketIds = (
  bucket: string,
  entries: ReadonlyArray<{ readonly id: string } | ToolCapability>,
  capIds: Map<string, string>,
): Option.Option<string> => {
  for (const [i, cap] of entries.entries()) {
    let id: string
    if (isToolCapability(cap)) {
      id = getToolId(cap)
    } else {
      id = cap.id
    }
    if (capIds.has(id)) {
      return Option.some(
        `${bucket}[${i}] (${id}): duplicate id within extension (also at ${capIds.get(id)}); cross-extension collisions are resolved by scope precedence, but intra-extension collisions are an authoring bug`,
      )
    }
    capIds.set(id, `${bucket}[${i}]`)
  }
  return Option.none()
}

const checkToolDescriptions = (tools: ReadonlyArray<ToolCapability>): Option.Option<string> => {
  for (const [i, cap] of tools.entries()) {
    if (!isToolCapability(cap)) {
      return Option.some(
        `tools[${i}]: tool must be created with \`tool({...})\` so Gent metadata is attached`,
      )
    }
    const metadata = getToolMetadata(cap)
    // The description is sent to the model as part of the tool schema, so a
    // blank one is as useless as a missing one.
    if (Predicate.isUndefined(cap.description) || cap.description.trim() === "") {
      return Option.some(
        `tools[${i}] (${metadata.id}): tool requires a non-empty \`description\` (the model sees it as the tool description)`,
      )
    }
  }
  return Option.none()
}

const validateCapabilities = (contribs: ExtensionContributions): Option.Option<string> => {
  const tools = contribs.tools ?? []
  const rpc = contribs.requests ?? []
  const toolErr = checkToolDescriptions(tools)
  if (Option.isSome(toolErr)) return toolErr
  const capIds = new Map<string, string>()
  return Option.orElse(checkBucketIds("tools", tools, capIds), () =>
    checkBucketIds("requests", rpc, capIds),
  )
}

const validateAgents = (contribs: ExtensionContributions): Option.Option<string> => {
  const agentNames = new Map<string, number>()
  for (const [i, a] of (contribs.agents ?? []).entries()) {
    if (agentNames.has(a.name)) {
      return Option.some(
        `agents[${i}] (${a.name}): duplicate name within extension (also at index ${agentNames.get(a.name)})`,
      )
    }
    agentNames.set(a.name, i)
  }
  return Option.none()
}

const validateResources = (contribs: ExtensionContributions): Option.Option<string> => {
  for (const [i, resource] of (contribs.resources ?? []).entries()) {
    if (Schema.is(ResourceId)(resource.id)) continue
    return Option.some(`resources[${i}]: resource requires a non-empty id`)
  }
  return Option.none()
}

const validateDriverIds = (contribs: ExtensionContributions): Option.Option<string> => {
  const allDriverIds = new Map<string, string>()
  for (const [i, d] of (contribs.modelDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return Option.some(
        `modelDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`,
      )
    }
    allDriverIds.set(d.id, `modelDrivers[${i}]`)
  }
  for (const [i, d] of (contribs.externalDrivers ?? []).entries()) {
    if (allDriverIds.has(d.id)) {
      return Option.some(
        `externalDrivers[${i}] (${d.id}): driver id already used by ${allDriverIds.get(d.id)}`,
      )
    }
    allDriverIds.set(d.id, `externalDrivers[${i}]`)
  }
  return Option.none()
}

const allowedContributionBuckets = new Set([
  "resources",
  "tools",
  "requests",
  "agents",
  "hooks",
  "modelDrivers",
  "externalDrivers",
])

const unknownBucketMessage = (key: string) =>
  `unknown contribution bucket "${key}"; supported buckets are ${Array.from(
    allowedContributionBuckets,
  ).join(", ")}`

const validateKnownBuckets = (contribs: ExtensionContributions): Option.Option<string> => {
  for (const key of Object.keys(contribs)) {
    if (!allowedContributionBuckets.has(key)) {
      return Option.some(unknownBucketMessage(key))
    }
  }
  return Option.none()
}

export const validateExtensionPackage = (
  manifest: ExtensionManifest,
  contribs: ExtensionContributions,
): Effect.Effect<void, ExtensionLoadError> =>
  Effect.gen(function* () {
    const checks = [
      validateKnownBuckets,
      validateResources,
      validateCapabilities,
      validateAgents,
      validateDriverIds,
    ]
    for (const check of checks) {
      const message = check(contribs)
      if (Option.isSome(message)) {
        return yield* new ExtensionLoadError({ extensionId: manifest.id, message: message.value })
      }
    }
  })

// ── file-lock ───────────────────────────────────────────────────────────────

interface LockEntry {
  readonly sem: TxSemaphore.TxSemaphore
  readonly refcount: number
}

interface FileLockApi {
  readonly withLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  /** Number of paths currently locked or queued for lock. Refcount-bounded —
   *  drops back to 0 once all callers release. Exposed for diagnostics +
   *  regression-locking the eviction invariant. */
  readonly currentSize: Effect.Effect<number>
}

export class FileLockService extends Context.Service<FileLockService, FileLockApi>()(
  "@gent/core/src/domain/extension/FileLockService",
) {
  static layer = Layer.effect(
    FileLockService,
    Effect.gen(function* () {
      // Refcount-bounded map: an entry exists only while at least one
      // caller holds (or is waiting on) the lock. Last release evicts.
      // Map size is bounded by concurrent in-flight lock holders, not
      // by total distinct paths ever touched.
      const locksRef = yield* TxRef.make(HashMap.empty<string, LockEntry>())
      const pathService = yield* Path.Path

      const acquire = Effect.fn("FileLockService.acquire")(function* (filePath: string) {
        const resolved = pathService.resolve(filePath)
        // Speculative TxSemaphore allocation outside the transaction;
        // only the winner gets installed, the loser is discarded.
        const fresh = yield* TxSemaphore.make(1)
        const sem = yield* TxRef.modify(locksRef, (current) => {
          const found = HashMap.get(current, resolved)
          if (found._tag === "Some") {
            const bumped: LockEntry = { sem: found.value.sem, refcount: found.value.refcount + 1 }
            return [found.value.sem, HashMap.set(current, resolved, bumped)]
          }
          const entry: LockEntry = { sem: fresh, refcount: 1 }
          return [fresh, HashMap.set(current, resolved, entry)]
        })
        return { sem, resolved }
      })

      const release = (resolved: string) =>
        TxRef.update(locksRef, (current) => {
          const found = HashMap.get(current, resolved)
          if (found._tag === "None") return current
          const next = found.value.refcount - 1
          if (next <= 0) return HashMap.remove(current, resolved)
          return HashMap.set(current, resolved, { sem: found.value.sem, refcount: next })
        })

      return FileLockService.of({
        withLock: (path, effect) =>
          Effect.acquireUseRelease(
            acquire(path),
            ({ sem }) => TxSemaphore.withPermits(sem, 1, effect),
            ({ resolved }) => release(resolved),
          ),
        currentSize: TxRef.get(locksRef).pipe(Effect.map((m) => HashMap.size(m))),
      })
    }),
  )
}

// ── file-writer ─────────────────────────────────────────────────────────────

/** File facade wiring shared by production and tool test composition. */
export const makeFileWriter = (fs: FileSystem.FileSystem, dirname: (path: string) => string) =>
  Effect.fn("ExtensionFiles.write")(function* (
    path: string,
    content: string,
    options?: { readonly atomic?: boolean },
  ) {
    if (options?.atomic !== true) return yield* fs.writeFileString(path, content)
    // Replace the directory entry, including a symlink, without changing its target.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempFileScoped({
          directory: dirname(path),
          prefix: ".gent-write-",
        })
        yield* fs.writeFileString(staging, content)
        yield* fs.rename(staging, path)
      }),
    )
  })

// ── session-mutations ───────────────────────────────────────────────────────

type SessionMutationError =
  | StorageError
  | EventStoreError
  | InvalidStateError
  | NotFoundError
  | SessionDepthLimitError

export interface SessionMutationsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<
    { sessionId: SessionId; branchId: BranchId; name: string },
    SessionMutationError | SessionRuntimeError
  >
  readonly renameSession: (input: {
    readonly sessionId: SessionId
    readonly name: string
  }) => Effect.Effect<{ renamed: boolean; name?: string }, SessionMutationError>
  readonly createSessionBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<{ branchId: BranchId }, SessionMutationError>
  readonly forkSessionBranch: (
    input: ForkBranchInput,
  ) => Effect.Effect<{ branchId: BranchId }, SessionMutationError>
  readonly switchActiveBranch: (
    input: SwitchBranchInput,
  ) => Effect.Effect<void, SessionMutationError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, SessionMutationError>
  /** Replace the session's settings; the reply is what was stored. */
  readonly updateSettings: (
    input: UpdateSessionSettingsInput,
  ) => Effect.Effect<SessionSettings, SessionMutationError>
}

export class SessionMutations extends Context.Service<SessionMutations, SessionMutationsService>()(
  "@gent/core/src/domain/extension/SessionMutations",
) {}
