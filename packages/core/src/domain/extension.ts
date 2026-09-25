import {
  Context,
  type Crypto,
  Effect,
  type FileSystem,
  HashMap,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  Schema,
  type Scope,
  type Stream,
  TxRef,
  TxSemaphore,
} from "effect"
import {
  type AgentDefinition,
  type AgentName,
  type ModelId,
  type ReasoningEffort,
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
import type { ModelDriverContribution } from "./driver.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { GentPlatform, GentPlatformOsInfo } from "../runtime/gent-platform.js"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  type MessageId,
  RequestId,
  SessionId,
  type ToolCallId,
} from "./ids.js"
import type { AgentEvent, EventStoreError } from "./event.js"
import { causeMessage } from "./guards.js"
import type { ApprovalDecision, ApprovalRequest, InteractionPendingError } from "./interaction.js"
import {
  type Branch,
  type Message,
  extensionMetadata,
  MessageMetadata,
  type Session,
  type SessionAdmission,
} from "./message.js"
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
 * - `scope` — the lifetime, declared at the type level via the literal.
 * - `layer` — the Layer providing one or more services. The `R` channel must
 *   include `ScopeOf<S>` so the typed scope brand gates instantiation. Work
 *   that must run when the resource starts goes in the layer build; disposal
 *   is a finalizer in that build. A layer that fails rejects its extension.
 *
 * Consumers yield the service Tags the layer provides; they never see the
 * Resource.
 */
interface ResourceContribution<A, S extends ResourceScope, R = never, E = never> {
  readonly id: ResourceId
  readonly scope: S
  readonly layer: Layer.Layer<A, E, R | ScopeOf<S>>
}

/**
 * Heterogeneous Resource type — used in arrays where the Resource set
 * spans multiple service tags + R/E channels. Hosts iterate this shape and
 * route each Resource to the appropriate engine.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema and brand factory owns nominal type boundary
export type AnyResourceContribution = ResourceContribution<any, ResourceScope, any, any>

// ── Smart constructor ──

/** Spec type accepted by {@link defineResource}. */
interface ResourceSpec<A, S extends ResourceScope, R = never, E = never> {
  /** Stable resource identity. */
  readonly id: string
  readonly scope: S
  readonly layer: Layer.Layer<A, E, R | ScopeOf<S>>
}

/**
 * Author-facing factory for a {@link ResourceContribution}.
 *
 * The factory infers the generics from the inputs (so authors don't write
 * `<MyService, "process", never, never>`) and brands the resource id.
 */
export const defineResource = <A, S extends ResourceScope, R = never, E = never>(
  spec: ResourceSpec<A, S, R, E>,
): ResourceContribution<A, S, R, E> => ({
  id: ResourceId.make(spec.id),
  scope: spec.scope,
  layer: spec.layer,
})

// ── contribution ────────────────────────────────────────────────────────────

/**
 * Contribution buckets — the typed sub-arrays the loader seals from an
 * extension's `host.register(domain, ...values)` and `host.on(kind, handler)`
 * calls. The bucket name is the discrimination: a leaf carries no kind field.
 *
 * Capabilities are authored through the typed factories `tool({...})` and
 * `request({...})` in `domain/capability.ts`. Slash commands are requests
 * carrying a `slash:` presentation block.
 *
 * Resources are authored through `defineResource({ id, scope, layer })` in
 * this file. Each leaf carries a stable resource identity; the leaf is widened
 * by structural assignability at the bucket boundary.
 *
 * @module
 */

// ── Typed buckets ──

/**
 * The set of buckets an extension may contribute to. Every field is optional;
 * an extension that registers nothing has none. Each bucket is homogeneously
 * typed, and the field name is the discrimination.
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
}

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
   * `contributions.requests`, `contributions.resources`, etc. The bucket name
   * is the discrimination.
   */
  readonly contributions: ExtensionContributions
}

/** `load` is a file that never became an extension: no import, no export, or untrusted. */
export type FailedExtensionPhase = "load" | "setup" | "validation" | "startup"

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
    // Code-unit order, not the locale's: this order picks conflict winners.
    return Order.String(a.manifest.id, b.manifest.id)
  })

// Extension Load Error

export class ExtensionLoadError extends Schema.TaggedError<ExtensionLoadError>(
  "@gent/core/src/domain/extension/ExtensionLoadError",
)("ExtensionLoadError", {
  extensionId: ExtensionId,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Turn-scoped input shapes for the explicit runtime seams. Prompt/context
// shaping, turn/message hooks, and tool-result enrichment live on hooks.

export interface SystemPromptInput {
  readonly basePrompt: string
  readonly agent: AgentDefinition
  /** False when no user can answer in this turn: a spawned session's turn no client opened (`turnCanAsk`). */
  readonly interactive?: boolean
  /**
   * Tools resolved for this turn, for a hook that renders them into the
   * rewritten prompt.
   */
  readonly tools?: ReadonlyArray<ToolCapability>
  /** Admitted host tools, including tools hidden from the model by modelSet. */
  readonly hostTools?: ReadonlyArray<ToolCapability>
}

/** What a `turnProjection` hook reads: the agent the turn dispatches, after config and run overrides. */
export interface TurnProjectionInput {
  readonly agent: AgentDefinition
}

export interface TurnAfterInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** The user message that opened the turn; `TurnCompleted.messageId` carries the same id. */
  readonly messageId: MessageId
  /**
   * The `steer` messages a step joined into this turn. Each ends with this
   * turn and has no turn end of its own. Only joins this process saw: a turn
   * resumed after a restart names none from before it.
   */
  readonly joinedMessageIds: ReadonlySet<MessageId>
  /**
   * When the turn started, in epoch milliseconds. A turn resumed after it
   * parked on an interaction keeps its start. A turn recovered after a
   * restart starts again at the recovery: the stored queue holds no start
   * time, so `startedAtMs` and `durationMs` count from the recovery.
   */
  readonly startedAtMs: number
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
   * output. This is true only once both are exhausted, and for a turn a
   * failed phase stopped (a storage write, a stream defect), which gets its
   * hooks once, after its receipt.
   */
  readonly streamFailed: boolean
  /** The turn spent its continuations and never answered. */
  readonly unanswered: boolean
  /** What the turn's model calls spent, and whether that is all of it. */
  readonly usage: TurnUsage
  /**
   * The keys of this extension's notices (`TurnProjection.notices`) that
   * reached the model in one of the turn's steps, when the turn answered.
   * An interrupted, failed or unanswered turn read nothing: the set is
   * empty, and every notice shows again next turn.
   */
  readonly readNotices: ReadonlySet<string>
}

/**
 * Provider-reported tokens of one turn.
 *
 * `known` sums the steps that reported usable counts. `complete` is false when
 * no model step ran, or a step reported none, was cut short, or ran before a
 * restart: `known` is then not the turn's total. `TurnCompleted.usage` carries
 * a total exactly when `complete` is true.
 *
 * `cacheReadTokens` and `cacheWriteTokens` are the parts of `inputTokens` the
 * provider read from and wrote to its prompt cache. `costUsd` prices the
 * steps and any compaction summary the turn wrote or tried to write; it is
 * none when one of them could not be priced (its model has no price, or its
 * counts are unknown, as for a summary that failed after its model was
 * admitted), so it is never a partial sum.
 */
export interface TurnUsage {
  readonly known: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly costUsd: Option.Option<number>
  }
  readonly complete: boolean
}

// ── Lifecycle hooks ──
//
// Per-extension, per-session handlers run by the runtime at the prompt and
// turn seams, and once when a branch's loop opens in this process
// (`loopOpen`). Registered with `host.on(kind, handler)` inside `setup`.
// Failures are always isolated: the runtime logs a warning and lets later hooks
// still fire.

export type ExtensionHook<Input, Output, E = never, R = never> = {
  readonly handler: (input: Input) => Effect.Effect<Output, E, R>
}

/** Input and output of every runtime hook kind. `host.on(kind, handler)` is typed by this map. */
interface ExtensionHookSignatures {
  readonly systemPrompt: { readonly input: SystemPromptInput; readonly output: string }
  readonly turnProjection: { readonly input: TurnProjectionInput; readonly output: TurnProjection }
  readonly turnAfter: { readonly input: TurnAfterInput; readonly output: void }
  /**
   * The branch's loop was built in this process: at the first operation after
   * a restart, or after the loop closed. It runs once per build, after the
   * loop resumed a turn a restart cut short, before or beside any turn. The
   * branch comes from `ExtensionContext`. A handler repairs what the previous
   * process left: it re-arms timers, resumes children, reports lost work.
   * No user watches it, so it cannot ask.
   */
  readonly loopOpen: { readonly input: void; readonly output: void }
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

/** Fragment a `turnProjection` hook returns to shape the turn's tools */
export interface ToolPolicyFragment {
  /** Tool names the host may run although the agent does not allow them. Agent deny still wins. */
  readonly include?: ReadonlyArray<string>
  /**
   * Model-facing subset of the final admitted host tools. The last supplied set
   * wins. Missing, denied, and filtered interactive tools cannot be restored here.
   * An empty set advertises no tools. Omission preserves the previous selection.
   */
  readonly modelSet?: ReadonlyArray<string>
}

/**
 * Something the model must see until a turn has read it: a fire nobody
 * answered, a child an interrupt stopped. It changes from turn to turn, so
 * it stays out of the system prompt, whose cached prefix it would break:
 * the runtime places every notice after the conversation, in each step's
 * request only, and stores none. A turn that answered with a notice in view
 * hands its `keys` back in `TurnAfterInput.readNotices`; the extension
 * clears exactly those.
 */
export interface TurnNotice {
  /** Names the notice; a later extension's notice with the same id replaces it. */
  readonly id: string
  /** Blank content shows nothing: the runtime drops the notice, and its keys never come back as read. */
  readonly content: string
  /** What the notice shows, in the extension's own terms. */
  readonly keys: ReadonlyArray<string>
}

/** Turn-time projection — needs agent/tool context, used during prompt assembly */
export interface TurnProjection {
  readonly toolPolicy?: ToolPolicyFragment
  /** Standing prompt content: the same from turn to turn while nothing changes. */
  readonly promptSections?: ReadonlyArray<PromptSection>
  readonly notices?: ReadonlyArray<TurnNotice>
}

// Extension — the core primitive

interface ExtensionHostFacts {
  readonly osInfo: GentPlatformOsInfo
  readonly homeDirectory: string
}

/** Host facts plus the id source core's own facet verbs mint request ids from. */
export interface ExtensionHostPlatform extends ExtensionHostFacts {
  readonly randomId: Effect.Effect<string>
}

/** Platform services the loader itself runs against. */
export type ExtensionLoaderServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Crypto.Crypto
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
 * It carries the setup-time facts (cwd, home, host facts)
 * and the two registration primitives:
 *
 * - `register(domain, ...values)` adds typed leaves to one registration
 *   domain: tools, requests, agents, resources, model drivers.
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
}

const registrationDomains: RegistrationDomainMap = {
  tool: "tools",
  request: "requests",
  agent: "agents",
  resource: "resources",
  modelDriver: "modelDrivers",
}

type RegistrationDomain = keyof typeof registrationDomains
type BucketOf<D extends RegistrationDomain> = RegistrationDomainMap[D]
type ElementOf<A> = A extends ReadonlyArray<infer Item> ? Item : never
type RegistrationValue<D extends RegistrationDomain> = ElementOf<
  NonNullable<ExtensionContributions[BucketOf<D>]>
>

export interface ExtensionHostService {
  readonly cwd: string
  readonly home: string
  readonly host: ExtensionHostFacts
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
    home: facts.home,
    host: {
      osInfo: facts.host.osInfo,
      homeDirectory: facts.host.homeDirectory,
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
    case "loopOpen":
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

/**
 * How `Session.send` puts a user message into a branch. Each mode takes only
 * its own fields.
 *
 * - `turn` starts a turn on another branch. `completion: "admission"` returns
 *   once that loop holds the turn; a `commandId` waits for the turn to end.
 *   The current branch refuses a `turn`: a turn that waits on its own loop
 *   never returns, so it takes `queue`. Two branches that send each other a
 *   `turn` with a `commandId` wait on each other; `completion: "admission"` is
 *   the safe shape for mutual traffic. A repeat of the same `commandId`
 *   with `admission` admits nothing new, but it opens the target's loop, so a
 *   turn the previous process left unfinished resumes.
 * - `queue` waits behind the running turn, keyed by `sourceId` so a repeat is
 *   a no-op and `dequeueFollowUp` can take it back. `wake` starts a turn even
 *   on a branch with no prior history.
 * - `steer` joins the running turn at its next step. An idle branch parks it
 *   unless `wake` asks for a turn now. A `requestId` makes a repeat a no-op,
 *   and names the message: `interjectionMessageId(requestId)`. A `stopMessage` with
 *   that `messageId` takes the steer back while it waits, and stops the turn
 *   it opened.
 *
 * `queue` and `steer` target the current branch when no target is named.
 *
 * Every mode stamps the sending extension's id on the message's `metadata`,
 * over any the caller set, and removes the client origin only the server
 * stamps: a turn it opens in a spawned session has no user to ask
 * (`turnCanAsk`). A client's extension request that sends to its own branch
 * while it runs sends as that client instead.
 */
export const SessionSendParams = Schema.Union([
  Schema.Struct({
    delivery: Schema.Literal("turn"),
    sessionId: SessionId,
    branchId: BranchId,
    content: Schema.String,
    commandId: Schema.optional(ActorCommandId),
    completion: Schema.optional(Schema.Literal("admission")),
    metadata: Schema.optional(MessageMetadata),
  }),
  Schema.Struct({
    delivery: Schema.Literal("queue"),
    sessionId: Schema.optional(SessionId),
    branchId: Schema.optional(BranchId),
    content: Schema.String,
    sourceId: Schema.String,
    metadata: Schema.optional(MessageMetadata),
    wake: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    delivery: Schema.Literal("steer"),
    sessionId: Schema.optional(SessionId),
    branchId: Schema.optional(BranchId),
    content: Schema.String,
    requestId: Schema.optional(RequestId),
    metadata: Schema.optional(MessageMetadata),
    wake: Schema.optional(Schema.Boolean),
  }),
]).pipe(Schema.toTaggedUnion("delivery"))
export type SessionSendParams = typeof SessionSendParams.Type

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
  /**
   * A new session, under a parent when one is named. The parent chain is
   * depth-limited. `historyBranchId` copies that branch's visible messages in
   * before the first turn. A `requestId` makes the call durable-once.
   */
  readonly create: (params: {
    readonly name?: string
    readonly cwd?: string
    readonly parentSessionId?: SessionId
    readonly parentBranchId?: BranchId
    readonly historyBranchId?: BranchId
    /** What every turn of the new session runs as: agent and run overrides. */
    readonly admission?: SessionAdmission
    /** The session's own model and reasoning; they win over the agent's, as a `/model` choice does. */
    readonly modelId?: ModelId
    readonly reasoningLevel?: ReasoningEffort
    readonly requestId?: RequestId
  }) => Effect.Effect<
    { readonly sessionId: SessionId; readonly branchId: BranchId },
    ExtensionServiceError
  >
  /** Delete a session and every descendant. Their loops are tombstoned, not awaited; deleting the caller's own session ends its turn. */
  readonly delete: (sessionId: SessionId) => Effect.Effect<void, ExtensionServiceError>
  /**
   * One user message into a branch; `delivery` picks how it lands. See
   * `SessionSendParams` for the three modes.
   */
  readonly send: (params: SessionSendParams) => Effect.Effect<void, ExtensionServiceError>
  /**
   * Stop a branch's running turn, whichever message opened it; the current
   * branch when no target is named. A `requestId` makes a repeat of the same
   * stop a no-op.
   */
  readonly stop: (params: {
    readonly sessionId?: SessionId
    readonly branchId?: BranchId
    readonly requestId?: RequestId
  }) => Effect.Effect<void, ExtensionServiceError>
  /**
   * Stop only what one message opens on a branch: its turn running now, its
   * turn that has not started yet, or a `steer` with that id that no step
   * has read (the steer is taken back). Waits for the branch's loop and
   * returns true when the stop reached the message there; false when the
   * loop no longer holds it (its turn ended, or a step joined it into a turn
   * another message opened, which runs on), and when an earlier stop already
   * stops the turn it opened. A steer taken back answers true, unless an
   * earlier stop from this same branch already stops the turn the steer
   * waited to join: that stop answered true, so the branch is told once. A
   * stop that reaches a running turn takes this branch's own waiting steers
   * back with it; a later stop of one of them answers false. A `requestId`
   * makes a repeat of the same stop a no-op.
   */
  readonly stopMessage: (params: {
    readonly sessionId?: SessionId
    readonly branchId?: BranchId
    readonly messageId: MessageId
    readonly requestId?: RequestId
  }) => Effect.Effect<boolean, ExtensionServiceError>
  /**
   * A branch's events: the durable history first, one `StreamSynchronized`
   * marker, then live delivery. Take until the marker for a bounded read.
   * `from: "now"` skips the history: the marker comes first, then only
   * events stored after the call, for a follower of what a loop does next.
   */
  readonly events: (target: {
    readonly sessionId: SessionId
    readonly branchId?: BranchId
    readonly from?: "start" | "now"
  }) => Stream.Stream<AgentEvent, ExtensionServiceError>
  /** Removes a queued follow-up by source; the current branch when no target is named. False when absent or already running. */
  readonly dequeueFollowUp: (params: {
    readonly sourceId: string
    readonly sessionId?: SessionId
    readonly branchId?: BranchId
  }) => Effect.Effect<boolean, ExtensionServiceError>
  /**
   * Keeps the current branch's loop resident until the enclosing scope
   * closes. A loop that nothing holds is passivated after about a minute
   * idle, and its branch scope closes with it, so work forked into that
   * scope that must outlive an idle stretch (a pending timer) holds the loop
   * for as long as it is pending. Outside a loop there is nothing to hold.
   */
  readonly holdResident: Effect.Effect<void, never, Scope.Scope>
  readonly listBranches: Effect.Effect<ReadonlyArray<Branch>, ExtensionServiceError>
  /**
   * Every session in the workspace, or with a `root` only that session and
   * the sessions below it by parent link, at any depth; a read that costs
   * the subtree, not the workspace. The durable half of an agent catalog:
   * survives restarts, but says nothing about what is running now.
   */
  readonly listSessions: (params?: {
    readonly root?: SessionId
  }) => Effect.Effect<ReadonlyArray<Session>, ExtensionServiceError>
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
      /** When the current turn began (epoch ms); `None` when no turn runs or the read failed. */
      readonly runningSince: Option.Option<number>
    }>,
    ExtensionServiceError
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
  readonly Session: ExtensionSessionService
  readonly Interaction: ExtensionInteractionService
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
  readonly cwd: string
  readonly home: string
  readonly Session: ExtensionSessionService
  readonly Interaction: ExtensionInteractionService
  readonly FileLock: ExtensionFileLockServiceApi
  readonly State: ExtensionStateServiceApi
}

export class ExtensionContext extends Context.Service<ExtensionContext, ExtensionContextService>()(
  "@gent/core/src/domain/extension/ExtensionContext",
) {}

/**
 * The per-leaf half of the extension context: the run's facets, plus the two
 * facts only a leaf knows. `toolCallId` names the call a leaf runs under, and
 * `State.changed` reports under the leaf's extension id. Every other facet is
 * forwarded, because the run already built it over the services that own its
 * inputs.
 */
const extensionServicesFromHostContext = (
  ctx: ExtensionHostContext & { readonly toolCallId?: ToolCallId },
): Context.Context<ExtensionContext> => {
  const extensionIdOption = Option.fromUndefinedOr(ctx.extensionId)
  const extensionId = Option.getOrElse(extensionIdOption, () => ExtensionId.make("unknown"))
  // Every message a leaf sends names it as the author, whatever the caller
  // set, and never carries the client origin only the server stamps: a turn
  // it opens in a spawned session knows no user started it.
  const send: ExtensionSessionService["send"] = (params) =>
    ctx.Session.send({ ...params, metadata: extensionMetadata(extensionId, params.metadata) })
  return Context.empty().pipe(
    Context.add(ExtensionContext, {
      extensionId,
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      agentName: ctx.agentName,
      toolCallId: ctx.toolCallId,
      cwd: ctx.cwd,
      home: ctx.home,
      Session: { ...ctx.Session, send },
      Interaction: ctx.Interaction,
      FileLock: ctx.FileLock,
      State: ctx.State(extensionIdOption),
    }),
  )
}

export const provideExtensionServices = <A, E, R>(
  ctx: ExtensionHostContext & { readonly toolCallId?: ToolCallId },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ExtensionContext>> =>
  effect.pipe(Effect.provideContext(extensionServicesFromHostContext(ctx)))

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
  // oxlint-disable-next-line effect/noAs -- The load membrane re-seals the extension effect after normalizing its failure channel.
  return sealed as Effect.Effect<A, ExtensionLoadError, R>
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
  return Option.none()
}

const allowedContributionBuckets = new Set([
  "resources",
  "tools",
  "requests",
  "agents",
  "hooks",
  "modelDrivers",
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
  /** Merge a settings change into the stored settings; the reply is what was stored. */
  readonly updateSettings: (
    input: UpdateSessionSettingsInput,
  ) => Effect.Effect<SessionSettings, SessionMutationError>
}

export class SessionMutations extends Context.Service<SessionMutations, SessionMutationsService>()(
  "@gent/core/src/domain/extension/SessionMutations",
) {}
