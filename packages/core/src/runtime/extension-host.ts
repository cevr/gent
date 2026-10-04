import {
  Cause,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  type PlatformError,
  Predicate,
  Result,
  Schema,
  Scope,
  type Scope as ScopeType,
  Semaphore,
  Stream,
} from "effect"
import {
  type AnyExtensionHook,
  type AnyResourceContribution,
  type ExtensionContext,
  type ExtensionContributions,
  type ExtensionFileLockServiceApi,
  type ExtensionModelsService,
  type ExtensionHook,
  ExtensionHost,
  type ExtensionHostContext,
  type ExtensionHostPlatform,
  ExtensionLoadError,
  type ExtensionLoaderServices,
  type ExtensionScope,
  extensionServiceError,
  ExtensionServiceError,
  type ExtensionSetupServices,
  type ExtensionExtensionsService,
  type ExtensionStateFacet,
  type ExtensionStatusInfo,
  type DisabledExtension,
  ExtensionStatus,
  type TurnNotice,
  type TurnProjection,
  type TurnProjectionInput,
  type FailedExtension,
  type FailedExtensionPhase,
  FileLockService,
  type GentExtension,
  isClientFile,
  type LoadedExtension,
  makeCollectingExtensionHost,
  mapExtensionServiceError,
  provideExtensionServices,
  type ResourceScope,
  sealRuntimeLoadedEffect,
  SessionMutations,
  SessionSendParams,
  sortExtensionsByScope,
  type SystemPromptInput,
  type ToolPolicyFragment,
  type SessionDeletedInput,
  type TurnAfterInput,
  validateExtensionPackage,
} from "../domain/extension.js"
import {
  type BranchId,
  ClientRequestGrant,
  ExtensionId,
  type InteractionRequestId,
  MessageId,
  ProcessGenerationId,
  RequestId,
  type RpcId,
  type SessionId,
  type ToolCallId,
  CurrentWorkspaceId,
  type WorkspaceId,
} from "../domain/ids.js"
import {
  bindRequestCapabilityExtension,
  type CapabilityError,
  CapabilityError as CapabilityErrorClass,
  type CapabilityNotFoundError,
  CapabilityNotFoundError as CapabilityNotFoundErrorClass,
  environmentSection,
  getToolId,
  getToolMetadata,
  isToolCapability,
  type PromptSection,
  type RequestCapability,
  type ToolCapability,
} from "../domain/capability.js"
import type { AgentDefinition } from "../domain/agent.js"
import { causeChainMessage, causeMessage, omitUndefined } from "../domain/guards.js"
import type {
  ApiClassContribution,
  ModelDriverContribution,
  ModelRouterContribution,
} from "../domain/driver.js"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { GentPlatform, type RuntimeModuleSource, SERVED_MODULE_QUERY } from "./gent-platform.js"
import {
  type ConfigLoadError,
  ConfigService,
  fileVersion,
  type FreshConfig,
  GENT_CONFIG_DIRECTORY,
  hasProjectScope,
  isProjectExtensionDirectoryTrusted,
  type ProviderConfig,
  RuntimeEnvironment,
  type UserConfig,
} from "./config.js"
import {
  EventId,
  EventStore,
  EventStoreError,
  ExtensionStateChanged,
  InteractionPresented,
  InteractionResolved,
  MessageReceived,
} from "../domain/event.js"
import {
  type ApprovalDecision,
  InteractionPendingError,
  type InteractionService,
  type InteractionStorageConfig,
  makeInteractionService,
} from "../domain/interaction.js"
import {
  BranchStorage,
  InteractionStorage,
  MessageStorage,
  RelationshipStorage,
  SessionStorage,
} from "../storage/storage.js"
import { SqlClient } from "effect/sql"
import * as Prompt from "effect/ai/Prompt"
import * as EffectEntry from "effect"
import { ActorStateRegistry, listStateEntityIds, stateOf } from "effect-encore"
import {
  type Branch,
  Message,
  type MessageMetadata,
  type RequesterBranch,
  type Session,
  type SteerCommand,
  turnCanAsk,
  isSpawnedSession,
} from "../domain/message.js"
import {
  AgentLoop as AgentLoopActor,
  entityIdOf,
  listWorkspaceLoops,
  type SendUserMessagePayload,
  type SessionRuntimeState,
} from "../domain/agent-loop.js"
import { StorageError } from "../domain/errors.js"
import type { AgentLoopTurnProfile } from "./turn.js"

// ── current-extension-host-context ──────────────────────────────────────────

export class CurrentExtensionHostContext extends Context.Service<
  CurrentExtensionHostContext,
  ExtensionHostContext
>()("@gent/core/src/runtime/extension-host/CurrentExtensionHostContext") {}

export const provideCurrentHostCtx =
  (hostCtx: ExtensionHostContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, CurrentExtensionHostContext>> =>
    effect.pipe(Effect.provideService(CurrentExtensionHostContext, hostCtx))

// ── extension-capability-context ────────────────────────────────────────────

// The facade takes typed params, but an extension can still build one mode's
// fields into another. Decode the type side, so a stray field fails loudly.
const decodeSessionSend = Schema.decodeUnknownEffect(Schema.toType(SessionSendParams))

const CurrentExtensionCapabilityContext = Context.Reference<Context.Context<never>>(
  "@gent/core/src/runtime/extension-host/CurrentExtensionCapabilityContext",
  {
    defaultValue: Context.empty,
  },
)

export const provideCurrentCapabilityContext =
  (capabilityContext: Context.Context<never> = Context.empty()) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.provideService(CurrentExtensionCapabilityContext, capabilityContext))

const provideExtensionCapabilityContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const capabilityContext = yield* CurrentExtensionCapabilityContext
    return yield* effect.pipe(Effect.provideContext(capabilityContext))
  })

// ── extension-effect-membrane ───────────────────────────────────────────────

interface ErasedEffectHandlers<A, E> {
  // The single host membrane: an extension effect fails or dies with unknown
  // values, parsed or handled after this point.
  // oxlint-disable-next-line effect/noUnknownParameters -- The membrane erases the extension effect's error channel.
  readonly onFailure: (error: unknown) => Effect.Effect<A, E>
  // oxlint-disable-next-line effect/noUnknownParameters -- A defect is an unknown thrown value.
  readonly onDefect: (defect: unknown) => Effect.Effect<A, E>
}

/**
 * Single membrane for extension-authored `Effect<A, E, R>` values whose `E`
 * and `R` channels are intentionally erased at the host boundary.
 *
 * `Effect.suspend` is load-bearing: it captures synchronous throws during
 * effect construction so hosts do not need a second `Effect.try` wrapper just
 * to seal them.
 */
const sealErasedEffect = <A, E>(
  effect: () => Effect.Effect<A, unknown, unknown>,
  handlers: ErasedEffectHandlers<A, E>,
  // The membrane intentionally erases the extension effect's `R` channel.
  // Callers use this ONLY at host boundaries where the extension runtime has
  // already provided the required services.
): Effect.Effect<A, E> => {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
  const sealed = Effect.suspend(effect).pipe(
    Effect.catchEager(handlers.onFailure),
    Effect.catchDefect(handlers.onDefect),
  )
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
  return sealed as Effect.Effect<A, E> // oxlint-disable-line effect/noAs, typescript/no-unsafe-type-assertion -- The membrane re-seals the extension effect after erasing its runtime channels.
}

/**
 * Variant for hosts that need the raw `Exit` to apply local failure policy
 * (`continue` / `isolate` / `halt`, lifecycle finalizer behavior, etc.).
 */
const exitErasedEffect = <A>(
  effect: () => Effect.Effect<A, unknown, unknown>,
): Effect.Effect<Exit.Exit<A, unknown>> => {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
  const exit = Effect.exit(Effect.suspend(effect))
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
  return exit as Effect.Effect<Exit.Exit<A, unknown>> // oxlint-disable-line effect/noAs, typescript/no-unsafe-type-assertion -- The membrane exposes the raw exit after erasing the extension effect channels.
}

// oxlint-disable-next-line typescript/no-explicit-any -- The resource membrane erases heterogeneous service outputs.
export type ErasedResourceLayer = Layer.Layer<any, never, never>

/**
 * Resource layers erase to `Layer.Layer<any>` so their heterogeneous error and
 * requirement channels do not leak into callers.
 */
export const eraseResourceLayer = <A, E, R>(layer: Layer.Layer<A, E, R>): ErasedResourceLayer => {
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The resource membrane intentionally erases heterogeneous service output and requirements.
  const erased = layer as unknown as ErasedResourceLayer
  return erased
}

// oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- The empty layer is the erased identity for heterogeneous resource composition.
export const emptyErasedResourceLayer: ErasedResourceLayer = Layer.empty as ErasedResourceLayer

/** Per-leaf facts layered over the current run's host context. */
interface ExtensionLeafFrame {
  readonly extensionId?: ExtensionId
  readonly toolCallId?: ToolCallId
}

/**
 * The one boundary every extension leaf crosses: tools, requests, and hooks
 * all read the current run's host context here, receive the `ExtensionContext`
 * facets built from it plus the leaf frame, and see the run's capability
 * context. Error and requirement sealing stays with the caller because each
 * leaf kind reports failures differently.
 */
export const provideExtensionLeaf =
  (frame: ExtensionLeafFrame) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, ExtensionContext> | CurrentExtensionHostContext> =>
    Effect.gen(function* () {
      const host = yield* CurrentExtensionHostContext
      return yield* provideExtensionServices({ ...host, ...frame }, effect).pipe(
        provideExtensionCapabilityContext,
      )
    })

// ── extension-hooks ─────────────────────────────────────────────────────────

interface CompiledExtensionHooks {
  readonly resolveSystemPrompt: (
    input: SystemPromptInput,
  ) => Effect.Effect<string, never, CurrentExtensionHostContext>
  readonly resolveTurnProjection: (
    input: TurnProjectionInput,
  ) => Effect.Effect<ExtensionTurnProjection, never, CurrentExtensionHostContext>
  /** Each extension's hooks read back only the notices its own projection showed. */
  readonly emitTurnAfter: (
    input: Omit<TurnAfterInput, "readNotices">,
    readNotices: ReadonlyMap<ExtensionId, ReadonlySet<string>>,
  ) => Effect.Effect<void, never, CurrentExtensionHostContext>
  /** The extensions with a `loopOpen` hook. */
  readonly loopOpenExtensions: ReadonlySet<ExtensionId>
  /** Runs the `loopOpen` hooks of the named extensions; the loop says which (see its activation). */
  readonly emitLoopOpen: (
    extensionIds: ReadonlySet<ExtensionId>,
  ) => Effect.Effect<void, never, CurrentExtensionHostContext>
  readonly emitSessionDeleted: (
    input: SessionDeletedInput,
  ) => Effect.Effect<void, never, CurrentExtensionHostContext>
}

/** A notice with the extension whose projection returned it. */
export interface ExtensionTurnNotice {
  readonly extensionId: ExtensionId
  readonly notice: TurnNotice
}

interface ExtensionTurnProjection {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
  readonly notices: ReadonlyArray<ExtensionTurnNotice>
}

interface RegisteredSystemPromptRewrite {
  readonly extensionId: ExtensionId
  readonly handler: ExtensionHook<SystemPromptInput, string, unknown, unknown>["handler"]
}

interface HookTurnProjectionSlot {
  readonly extensionId: ExtensionId
  readonly handler: (input: TurnProjectionInput) => Effect.Effect<TurnProjection, unknown, unknown>
}

interface RegisteredHook<Input> {
  readonly extensionId: ExtensionId
  readonly handler: (input: Input) => Effect.Effect<void, unknown, unknown>
}

const runHook = <Input>(input: Input, registered: RegisteredHook<Input>) =>
  Effect.gen(function* () {
    const exit = yield* exitErasedEffect(() =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
      registered.handler(input).pipe(provideExtensionLeaf({ extensionId: registered.extensionId })),
    )
    if (exit._tag === "Success") return
    yield* Effect.logWarning("extension.hook.handler.failed").pipe(
      Effect.annotateLogs({
        extensionId: registered.extensionId,
        cause: Cause.pretty(exit.cause),
      }),
    )
  })

const collectTurnProjection = (
  projection: Option.Option<ExtensionTurnProjection>,
  sectionsById: Map<string, PromptSection>,
  policyFragments: ToolPolicyFragment[],
  noticesById: Map<string, ExtensionTurnNotice>,
) => {
  if (Option.isNone(projection)) return
  for (const section of projection.value.promptSections) sectionsById.set(section.id, section)
  for (const fragment of projection.value.policyFragments) policyFragments.push(fragment)
  for (const notice of projection.value.notices) noticesById.set(notice.notice.id, notice)
}

const runTurnProjectionHook = (slot: HookTurnProjectionSlot, input: TurnProjectionInput) =>
  sealErasedEffect<Option.Option<ExtensionTurnProjection>, never>(
    () =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
      slot
        .handler(input)
        .pipe(
          Effect.map((projection) => {
            const promptSections = Option.getOrElse(
              Option.fromUndefinedOr(projection.promptSections),
              () => [],
            )
            let policyFragments: ReadonlyArray<ToolPolicyFragment> = []
            if (!Predicate.isUndefined(projection.toolPolicy)) {
              policyFragments = [projection.toolPolicy]
            }
            // A notice with no text shows nothing, so it is dropped here: every
            // notice core keeps is one a step's request carries, and only
            // those keys can come back as read.
            const notices = Option.getOrElse(Option.fromUndefinedOr(projection.notices), () => [])
              .filter((notice) => notice.content.trim() !== "")
              .map((notice): ExtensionTurnNotice => ({ extensionId: slot.extensionId, notice }))
            return Option.some({ promptSections, policyFragments, notices })
          }),
        )
        .pipe(provideExtensionLeaf({ extensionId: slot.extensionId })),
    {
      onFailure: (error) =>
        Effect.logWarning("extension.hook.turn-projection.failed").pipe(
          Effect.annotateLogs({
            extensionId: slot.extensionId,
            error: String(error),
          }),
          Effect.as(Option.none()),
        ),
      onDefect: (defect) =>
        Effect.logWarning("extension.hook.turn-projection.defect").pipe(
          Effect.annotateLogs({
            extensionId: slot.extensionId,
            defect: String(defect),
          }),
          Effect.as(Option.none()),
        ),
    },
  )

const eraseHookEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A> =>
  // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Hook effects cross the extension membrane; compile-time E/R are erased and resealed by sealErasedEffect at every invocation site.
  effect as Effect.Effect<A>

const collectHookSlot = (
  ext: LoadedExtension,
  slot: AnyExtensionHook,
  slots: {
    systemPrompt: RegisteredSystemPromptRewrite[]
    turnProjection: HookTurnProjectionSlot[]
    turnAfter: RegisteredHook<TurnAfterInput>[]
    loopOpen: RegisteredHook<void>[]
    sessionDeleted: RegisteredHook<SessionDeletedInput>[]
  },
) => {
  switch (slot.kind) {
    case "systemPrompt":
      slots.systemPrompt.push({ extensionId: ext.manifest.id, handler: slot.hook.handler })
      return
    case "turnProjection":
      slots.turnProjection.push({
        extensionId: ext.manifest.id,
        handler: (input) => eraseHookEffect(slot.hook.handler(input)),
      })
      return
    case "turnAfter":
      slots.turnAfter.push({
        extensionId: ext.manifest.id,
        handler: slot.hook.handler,
      })
      return
    case "loopOpen":
      slots.loopOpen.push({
        extensionId: ext.manifest.id,
        handler: slot.hook.handler,
      })
      return
    case "sessionDeleted":
      slots.sessionDeleted.push({
        extensionId: ext.manifest.id,
        handler: slot.hook.handler,
      })
      return
  }
}

/**
 * How long a delete waits for one extension's `sessionDeleted` handler. The
 * rows are already gone, so a handler that never returns must not hold the
 * delete RPC; past the bound it is interrupted and a warning is logged.
 */
export const SESSION_DELETED_HOOK_TIMEOUT = Duration.seconds(30)

export const compileExtensionHooks = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledExtensionHooks => {
  const sorted = sortExtensionsByScope(extensions)
  const systemPromptSlots: RegisteredSystemPromptRewrite[] = []
  const turnProjectionSlots: HookTurnProjectionSlot[] = []
  const turnAfterSlots: RegisteredHook<TurnAfterInput>[] = []
  const loopOpenSlots: RegisteredHook<void>[] = []
  const sessionDeletedSlots: RegisteredHook<SessionDeletedInput>[] = []
  const hookSlots = {
    systemPrompt: systemPromptSlots,
    turnProjection: turnProjectionSlots,
    turnAfter: turnAfterSlots,
    loopOpen: loopOpenSlots,
    sessionDeleted: sessionDeletedSlots,
  }

  for (const ext of sorted) {
    for (const slot of ext.contributions.hooks ?? []) {
      collectHookSlot(ext, slot, hookSlots)
    }
  }

  return {
    resolveSystemPrompt: (input) =>
      Effect.gen(function* () {
        let current = input.basePrompt
        for (const slot of systemPromptSlots) {
          current = yield* sealErasedEffect(
            () =>
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
              slot
                .handler({ ...input, basePrompt: current })
                .pipe(provideExtensionLeaf({ extensionId: slot.extensionId })),
            {
              onFailure: (error) =>
                Effect.logWarning("extension.hook.system-prompt.failed").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    error: String(error),
                  }),
                  Effect.as(current),
                ),
              onDefect: (defect) =>
                Effect.logWarning("extension.hook.system-prompt.defect").pipe(
                  Effect.annotateLogs({
                    extensionId: slot.extensionId,
                    defect: String(defect),
                  }),
                  Effect.as(current),
                ),
            },
          )
        }
        return current
      }),

    resolveTurnProjection: (input) =>
      Effect.gen(function* () {
        const sectionsById = new Map<string, PromptSection>()
        const policyFragments: ToolPolicyFragment[] = []
        const noticesById = new Map<string, ExtensionTurnNotice>()

        for (const slot of turnProjectionSlots) {
          collectTurnProjection(
            yield* runTurnProjectionHook(slot, input),
            sectionsById,
            policyFragments,
            noticesById,
          )
        }

        return {
          promptSections: [...sectionsById.values()],
          policyFragments,
          notices: [...noticesById.values()],
        }
      }),

    emitTurnAfter: (input, readNotices) =>
      Effect.gen(function* () {
        for (const slot of turnAfterSlots) {
          const read = Option.getOrElse(
            Option.fromUndefinedOr(readNotices.get(slot.extensionId)),
            () => new Set<string>(),
          )
          yield* runHook({ ...input, readNotices: read }, slot)
        }
      }),

    loopOpenExtensions: new Set(loopOpenSlots.map((slot) => slot.extensionId)),
    // Each hook runs on its own: one that never returns holds up no other.
    // The slots are fixed when the registry compiles, one per registration.
    emitLoopOpen: (extensionIds) => {
      const slots = loopOpenSlots.filter((slot) => extensionIds.has(slot.extensionId))
      return Effect.forEach(slots, (slot) => runHook(void 0, slot), {
        concurrency: Math.max(slots.length, 1),
        discard: true,
      })
    },

    // Each extension removes its own data, so no handler waits for another.
    // Each runs up to its bound; one that never returns is cut and logged.
    emitSessionDeleted: (input) =>
      Effect.forEach(
        sessionDeletedSlots,
        (slot) =>
          runHook(input, slot).pipe(
            Effect.timeoutOption(SESSION_DELETED_HOOK_TIMEOUT),
            Effect.flatMap(
              Option.match({
                onSome: () => Effect.void,
                onNone: () =>
                  Effect.logWarning("extension.hook.session-deleted.timeout").pipe(
                    Effect.annotateLogs({
                      extensionId: slot.extensionId,
                      sessionId: input.sessionId,
                      timeout: Duration.format(SESSION_DELETED_HOOK_TIMEOUT),
                    }),
                  ),
              }),
            ),
          ),
        { concurrency: Math.max(sessionDeletedSlots.length, 1), discard: true },
      ),
  }
}

// ── registry ────────────────────────────────────────────────────────────────

// SlashCommand — public-facing slash entry. Built from `requests:` bucket
// winners that carry a `slash:` presentation block. The slash block is the
// load-bearing filter.
interface SlashCommand {
  /** Routing key (capability id, extension-local). */
  readonly name: string
  /** Author-supplied display name for the slash menu. Falls back to `name`
   *  when absent. */
  readonly displayName?: string
  readonly description?: string
  /** Author-supplied slash-menu category. */
  readonly category?: string
  /** Author-supplied keybind hint (display-only). */
  readonly keybind?: string
  readonly extensionId: ExtensionId
  readonly capabilityId: string
}

// Resolved snapshot — the immutable compiled state

interface ResolvedExtensions {
  /** Winning model tool per name, with the extension that registered it. */
  readonly modelCapabilities: ReadonlyMap<string, RegisteredToolEntry>
  readonly rpcRegistry: CompiledRpcRegistry
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly apiClasses: ReadonlyMap<string, ApiClassContribution>
  readonly modelRouters: ReadonlyMap<string, ModelRouterContribution>
  readonly slashCommands: ReadonlyArray<SlashCommand>
  readonly extensionHooks: CompiledExtensionHooks
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions: ReadonlyArray<FailedExtension>
  readonly disabledExtensions: ReadonlyArray<DisabledExtension>
  readonly extensionStatuses: ReadonlyArray<ExtensionStatusInfo>
}

interface RegisteredToolEntry {
  readonly kind: "tool"
  readonly extensionId: ExtensionId
  readonly extension: LoadedExtension
  readonly capability: ToolCapability
}

interface RegisteredRpcEntry {
  readonly kind: "rpc"
  readonly extensionId: ExtensionId
  readonly capability: RequestCapability
}

type RegisteredCapabilityEntry = RegisteredToolEntry | RegisteredRpcEntry

interface CompiledRpcRegistry {
  /** Whether the request declared `answersDuringTurn`; false for an unknown request. */
  readonly answersDuringTurn: (extensionId: ExtensionId, capabilityId: RpcId | string) => boolean
  readonly run: (
    extensionId: ExtensionId,
    capabilityId: RpcId | string,
    // oxlint-disable-next-line effect/noUnknownParameters -- The selected capability schema validates this erased transport payload.
    input: unknown,
  ) => Effect.Effect<
    unknown,
    CapabilityError | CapabilityNotFoundError,
    CurrentExtensionHostContext | FileSystem.FileSystem | Path.Path
  >
}

/** Compile a keyed bucket from sorted extensions. Later scope wins. */
const compileBucket = <T>(
  sorted: ReadonlyArray<LoadedExtension>,
  pickBucket: (ext: LoadedExtension) => ReadonlyArray<T>,
  getKey: (item: T) => string,
): Map<string, T> => {
  const result = new Map<string, T>()
  for (const ext of sorted) {
    const items = pickBucket(ext)
    for (const item of items) {
      const key = getKey(item)
      result.set(key, item)
    }
  }
  return result
}

/** The id a tool or request registration answers to; both share one namespace. */
const capabilityEntryId = (entry: RegisteredCapabilityEntry): string => {
  if (entry.kind === "tool") return String(getToolId(entry.capability))
  return String(entry.capability.id)
}

/**
 * The registration each capability id resolves to. The entries are in scope
 * order, so a later-scope contribution from either bucket shadows an earlier
 * registration with the same id.
 */
const compileCapabilityWinners = (
  entries: ReadonlyArray<RegisteredCapabilityEntry>,
): ReadonlyMap<string, RegisteredCapabilityEntry> => {
  const winners = new Map<string, RegisteredCapabilityEntry>()
  for (const entry of entries) winners.set(capabilityEntryId(entry), entry)
  return winners
}

const compileSlashCommands = (
  winners: ReadonlyMap<string, RegisteredCapabilityEntry>,
): ReadonlyArray<SlashCommand> => {
  const commands: SlashCommand[] = []
  for (const entry of winners.values()) {
    if (entry.kind !== "rpc") continue
    if (Predicate.isUndefined(entry.capability.slash)) continue
    commands.push(capabilityToCommand(entry.extensionId, entry.capability))
  }
  return commands
}

/** Every tool and request registration, in scope order (later scopes last). */
const compileCapabilityEntries = (
  sorted: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredCapabilityEntry> => {
  const entries: RegisteredCapabilityEntry[] = []
  for (const ext of sorted) {
    for (const capability of Option.getOrElse(
      Option.fromUndefinedOr(ext.contributions.tools),
      () => [],
    )) {
      entries.push({ kind: "tool", extensionId: ext.manifest.id, extension: ext, capability })
    }
    for (const capability of Option.getOrElse(
      Option.fromUndefinedOr(ext.contributions.requests),
      () => [],
    )) {
      entries.push({ kind: "rpc", extensionId: ext.manifest.id, capability })
    }
  }
  return entries
}

const resolveCapabilityEntry = (
  entries: ReadonlyArray<RegisteredCapabilityEntry>,
  extensionId: ExtensionId,
  capabilityId: RpcId | string,
): Option.Option<RegisteredCapabilityEntry> => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i]
    if (Predicate.isUndefined(candidate)) continue
    if (candidate.extensionId === extensionId && capabilityEntryId(candidate) === capabilityId)
      return Option.some(candidate)
  }
  return Option.none()
}

const runExtensionCapability = (
  extensionId: ExtensionId,
  capabilityId: RpcId | string,
  capability: RequestCapability,
  // oxlint-disable-next-line effect/noUnknownParameters -- Erased request inputs are decoded by the capability-owned schema below.
  input: unknown,
) =>
  Effect.gen(function* () {
    const decodedInputOption = Schema.decodeUnknownOption(capability.input)(input)
    if (Option.isNone(decodedInputOption)) {
      return yield* new CapabilityErrorClass({
        extensionId,
        capabilityId,
        reason: "input decode failed",
      })
    }
    const decodedInput = decodedInputOption.value

    const output = yield* sealErasedEffect(
      () =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the extension membrane erases the author effect channels and seals them here.
        capability.effect(decodedInput),
      {
        onFailure: (error) => {
          if (Schema.is(CapabilityErrorClass)(error)) {
            return Effect.fail(error)
          }
          return Effect.fail(
            new CapabilityErrorClass({
              extensionId,
              capabilityId,
              reason: `handler failure: ${String(error)}`,
            }),
          )
        },
        onDefect: (defect) =>
          Effect.fail(
            new CapabilityErrorClass({
              extensionId,
              capabilityId,
              reason: `handler defect: ${String(defect)}`,
            }),
          ),
      },
    )

    const encodedOutput = Schema.encodeOption(capability.output)(output)
    if (Option.isNone(encodedOutput)) {
      return yield* new CapabilityErrorClass({
        extensionId,
        capabilityId,
        reason: "output validation failed",
      })
    }
    return output
  })

const compileRpcRegistry = (
  entries: ReadonlyArray<RegisteredCapabilityEntry>,
): CompiledRpcRegistry => ({
  answersDuringTurn: (extensionId, capabilityId) =>
    Option.match(resolveCapabilityEntry(entries, extensionId, capabilityId), {
      onNone: () => false,
      onSome: (entry) => entry.kind === "rpc" && entry.capability.answersDuringTurn === true,
    }),
  run: Effect.fn("CompiledRpcRegistry.run")(function* (extensionId, capabilityId, input) {
    const entry = resolveCapabilityEntry(entries, extensionId, capabilityId)
    if (Option.isNone(entry) || entry.value.kind !== "rpc") {
      return yield* new CapabilityNotFoundErrorClass({ extensionId, capabilityId })
    }
    return yield* runExtensionCapability(
      extensionId,
      capabilityId,
      entry.value.capability,
      input,
    ).pipe(provideExtensionLeaf({ extensionId }))
  }),
})

const activeExtensionStatus = (extension: LoadedExtension): ExtensionStatusInfo => ({
  manifest: extension.manifest,
  scope: extension.scope,
  sourcePath: extension.sourcePath,
  ...omitUndefined({ version: extension.version, reloadFailed: extension.reloadFailed }),
  status: "active",
})

const failedExtensionStatus = (failure: FailedExtension): ExtensionStatusInfo => ({
  ...failure,
  status: "failed",
})

const disabledExtensionStatus = (disabled: DisabledExtension): ExtensionStatusInfo => ({
  manifest: disabled.manifest,
  scope: disabled.scope,
  sourcePath: disabled.sourcePath,
  status: "disabled",
})

/** A health status as the `Extensions` facet reports it. */
const extensionStatusOf = (info: ExtensionStatusInfo): ExtensionStatus => {
  const identity = { id: info.manifest.id, scope: info.scope, sourcePath: info.sourcePath }
  if (info.status === "failed") {
    return ExtensionStatus.cases.Failed.make({ ...identity, phase: info.phase, error: info.error })
  }
  if (info.status === "disabled") return ExtensionStatus.cases.Disabled.make(identity)
  return ExtensionStatus.cases.Active.make({
    ...identity,
    ...omitUndefined({ version: info.version, reloadFailed: info.reloadFailed }),
  })
}

const capabilityToCommand = (extensionId: ExtensionId, cap: RequestCapability): SlashCommand => {
  const slash = Option.fromUndefinedOr(cap.slash)
  const name = Option.match(slash, {
    onNone: () => String(cap.id),
    onSome: (value) =>
      Option.getOrElse(Option.fromUndefinedOr(value.trigger), () => String(cap.id)),
  })
  const description = Option.match(slash, {
    onNone: () => Option.fromUndefinedOr(cap.description),
    onSome: (value) =>
      Option.match(Option.fromUndefinedOr(value.description), {
        onNone: () => Option.fromUndefinedOr(cap.description),
        onSome: Option.some,
      }),
  })
  const displayName = Option.flatMap(slash, (value) => Option.fromUndefinedOr(value.name))
  const category = Option.flatMap(slash, (value) => Option.fromUndefinedOr(value.category))
  const keybind = Option.flatMap(slash, (value) => Option.fromUndefinedOr(value.keybind))
  return {
    name,
    extensionId,
    capabilityId: String(cap.id),
    ...omitUndefined({
      displayName: Option.getOrUndefined(displayName),
      description: Option.getOrUndefined(description),
      category: Option.getOrUndefined(category),
      keybind: Option.getOrUndefined(keybind),
    }),
  }
}

/** Compile prevalidated extensions into an immutable resolved snapshot. */
export const resolveExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  disabledExtensions: ReadonlyArray<DisabledExtension> = [],
): ResolvedExtensions => {
  const mergedFailures = [...failedExtensions]
  const sorted = sortExtensionsByScope(extensions)

  // Tool resolution — identity-first scope shadowing followed by bucket
  // authorization. Every leaf (regardless of bucket) enters the candidate map;
  // authorization (`kind === "tool"`) happens AFTER selection so a higher-scope
  // command/rpc override correctly hides a shadowed builtin tool.
  const capabilityEntries = compileCapabilityEntries(sorted)
  const capabilityWinners = compileCapabilityWinners(capabilityEntries)
  const rpcRegistry = compileRpcRegistry(capabilityEntries)
  const modelCapabilities = new Map<string, RegisteredToolEntry>()
  for (const [id, entry] of capabilityWinners) {
    if (entry.kind !== "tool") continue
    modelCapabilities.set(id, entry)
  }

  const agents = compileBucket(
    sorted,
    (e) => Option.getOrElse(Option.fromUndefinedOr(e.contributions.agents), () => []),
    (a) => a.name,
  )
  const modelDrivers = compileBucket(
    sorted,
    (e) => Option.getOrElse(Option.fromUndefinedOr(e.contributions.modelDrivers), () => []),
    (d) => d.id,
  )
  const apiClasses = compileBucket(
    sorted,
    (e) => Option.getOrElse(Option.fromUndefinedOr(e.contributions.apiClasses), () => []),
    (apiClass) => apiClass.id,
  )
  const modelRouters = compileBucket(
    sorted,
    (e) => Option.getOrElse(Option.fromUndefinedOr(e.contributions.modelRouters), () => []),
    (router) => router.id,
  )

  const slashCommands = compileSlashCommands(capabilityWinners)

  const extensionHooks = compileExtensionHooks(sorted)
  const extensionStatuses: ExtensionStatusInfo[] = [
    ...sorted.map(activeExtensionStatus),
    ...mergedFailures.map(failedExtensionStatus),
    ...disabledExtensions.map(disabledExtensionStatus),
  ]

  return {
    modelCapabilities,
    rpcRegistry,
    agents,
    modelDrivers,
    apiClasses,
    modelRouters,
    slashCommands,
    extensionHooks,
    extensions: sorted,
    failedExtensions: mergedFailures,
    disabledExtensions,
    extensionStatuses,
  }
}

// Extension Registry Service

/**
 * The resolved extensions one profile runs with: tools, requests, agents,
 * model drivers, and hooks. A turn reads the registry of its own
 * profile, so a cwd-scoped extension's drivers and tools reach only its turns.
 */
export interface ExtensionRegistryService {
  readonly getResolved: () => ResolvedExtensions
  /**
   * The `providers` and `disabledProviders` of the profile's config, read
   * from the files on each call: a provider edit needs no new profile.
   */
  readonly providerConfig: Effect.Effect<ProviderConfig>
}

/** A registry whose config names no provider. */
const NO_PROVIDER_CONFIG: Effect.Effect<ProviderConfig> = Effect.succeed({})

export class ExtensionRegistry extends Context.Service<
  ExtensionRegistry,
  ExtensionRegistryService
>()("@gent/core/src/runtime/extension-host/ExtensionRegistry") {
  static fromResolved = (
    resolved: ResolvedExtensions,
    providerConfig: Effect.Effect<ProviderConfig> = NO_PROVIDER_CONFIG,
  ): Layer.Layer<ExtensionRegistry> =>
    Layer.succeed(
      ExtensionRegistry,
      ExtensionRegistry.of({
        getResolved: () => resolved,
        providerConfig,
      }),
    )

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
}

// ── resource-layer ──────────────────────────────────────────────────────────

/*
 * Resource layer assembly: merges every Resource layer of one scope behind the
 * heterogeneous erasure membrane. Start work and disposal live in each layer.
 */

interface ResourceEntry {
  readonly extensionId: ExtensionId
  readonly resource: AnyResourceContribution
}

const collectResourceEntries = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope,
): ReadonlyArray<ResourceEntry> =>
  extensions.flatMap((ext) =>
    (ext.contributions.resources ?? [])
      .filter((resource) => resource.scope === scope)
      .map((resource) => ({ extensionId: ext.manifest.id, resource })),
  )

const buildResourceLayer = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope = "process",
): ErasedResourceLayer => {
  const entries = collectResourceEntries(extensions, scope)
  if (entries.length === 0) return emptyErasedResourceLayer

  return entries.reduce<ErasedResourceLayer>(
    (acc, { resource }) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.
      Layer.merge(acc, eraseResourceLayer(resource.layer)),
    emptyErasedResourceLayer,
  )
}

/** Makes a region of an uninterruptible effect interruptible (`Effect.uninterruptibleMask`). */
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/** One extension whose Resources of a scope failed to build, and the cause. */
interface FailedResourceBuild {
  readonly extension: LoadedExtension
  /** The extension suspended at the `startup` phase, with the full cause. */
  readonly failure: FailedExtension
  /** The messages down the cause chain, for a reader. */
  readonly message: string
}

/**
 * The resolved extensions with some suspended: their tools, requests, hooks,
 * agents and drivers leave the registry, and they are reported failed. A
 * profile suspends an extension whose process Resource failed this way
 * (`resolveExtensions` over the rest); a branch loop suspends one whose
 * branch Resource failed, for that loop only.
 */
export const suspendExtensions = (
  resolved: ResolvedExtensions,
  failed: ReadonlyArray<FailedExtension>,
): ResolvedExtensions => {
  if (failed.length === 0) return resolved
  const suspended = new Set(failed.map((failure) => failure.manifest.id))
  return resolveExtensions(
    resolved.extensions.filter((extension) => !suspended.has(extension.manifest.id)),
    [...resolved.failedExtensions, ...failed],
    resolved.disabledExtensions,
  )
}

interface BuiltScopeResources {
  /** The extensions whose Resources of the scope are live (or have none). */
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedResourceBuild>
  /** The given context with every live extension's services merged over it. */
  readonly context: Context.Context<unknown>
}

/**
 * What a built Resource of an extension depends on in that extension: its
 * scope, id, source and file version.
 */
const extensionResourceIdentity = (extension: LoadedExtension): string => {
  let source = extension.sourcePath
  if (!Predicate.isUndefined(extension.version)) source = `${source}@${extension.version}`
  return `${extension.scope}:${extension.manifest.id}:${source}`
}

const resourceScopesOf = (extension: LoadedExtension): ReadonlySet<ResourceScope> =>
  new Set((extension.contributions.resources ?? []).map((resource) => resource.scope))

/**
 * The build key of each extension's `scope` Resources: `root`, then the
 * identities of everything the build reads, in resolution order. Two builds
 * with one key build the same code over the same services, so a later build
 * can share an earlier one.
 *
 * A process Resource builds over the process Resources of the extensions
 * before it, so its key is theirs and its own: an edit changes the key of
 * the edited extension and of each one after it. A branch Resource builds
 * over the whole process context, where a later extension can override a
 * service an earlier one built, and over the branch Resources before it. So
 * its key holds every process-bearing extension, then the branch-bearing
 * ones up to and including it.
 *
 * These are the keys of what the set declares. A profile's process Resources
 * key on what started instead (`startProcessResources`), since a last good
 * version can start in place of a declared version.
 */
export const resourceBuildKeys = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope,
  root: string,
): ReadonlyMap<LoadedExtension, string> => {
  const sorted = sortExtensionsByScope(extensions)
  const chain = [root]
  if (scope === "branch") {
    for (const extension of sorted) {
      if (resourceScopesOf(extension).has("process")) {
        chain.push(extensionResourceIdentity(extension))
      }
    }
  }
  const keys = new Map<LoadedExtension, string>()
  for (const extension of sorted) {
    if (!resourceScopesOf(extension).has(scope)) continue
    chain.push(extensionResourceIdentity(extension))
    keys.set(extension, chain.join("\u0000"))
  }
  return keys
}

/**
 * Build one scope's Resources extension by extension, in resolution order, so
 * a later extension's service wins exactly as it does in the registry. Each
 * extension builds in its own child of `parent`, over the services the
 * extensions before it built. A build that fails closes its own scope, is
 * logged naming its extension, and is returned in `failed`; the other
 * extensions' Resources stay live. Process and branch Resources both build
 * here.
 *
 * `reuse` hands over services an earlier build left to share instead of
 * building them; `built` receives each new build and the scope that holds it.
 * Only a build runs inside `restore`: an interrupt of the caller there stops
 * the whole build, while an extension that interrupts itself is a failure.
 */
export const buildScopeResources = (params: {
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly scope: ResourceScope
  readonly context: Context.Context<unknown>
  readonly parent: Scope.Scope
  readonly restore: Restore
  readonly reuse?: (extension: LoadedExtension) => Option.Option<Context.Context<unknown>>
  readonly built?: (
    extension: LoadedExtension,
    scope: Scope.Closeable,
    context: Context.Context<unknown>,
  ) => void
  /**
   * The version to run in place of an extension whose Resources fail to
   * build: its last good version, marked with the failure. It is shared or
   * built as any other; when it fails too, the extension is failed.
   */
  readonly fallback?: (extension: LoadedExtension, error: string) => Option.Option<LoadedExtension>
}): Effect.Effect<BuiltScopeResources> =>
  Effect.gen(function* () {
    let context = params.context
    const active: Array<LoadedExtension> = []
    const failed: Array<FailedResourceBuild> = []
    /** Share or build one extension's Resources over the context so far. */
    const start = (extension: LoadedExtension) =>
      Effect.gen(function* () {
        const reused = params.reuse?.(extension) ?? Option.none()
        if (Option.isSome(reused)) return Exit.succeed(reused.value)
        const extensionScope = yield* Scope.fork(params.parent)
        const built = yield* params
          .restore(
            Layer.build(buildResourceLayer([extension], params.scope)).pipe(
              Effect.provideContext(context),
              Effect.provideService(Scope.Scope, extensionScope),
            ),
          )
          .pipe(Effect.exit)
        if (Exit.isSuccess(built)) {
          params.built?.(extension, extensionScope, built.value)
          return built
        }
        yield* Scope.close(extensionScope, built)
        // An interrupt of the caller stops the whole build; it is not a failed
        // extension. An extension that interrupts itself is. The cause cannot
        // tell them apart, the fiber can: an interruptible no-op fails at once
        // only when this fiber was interrupted.
        if (Cause.hasInterruptsOnly(built.cause)) yield* params.restore(Effect.void)
        return built
      })
    for (const extension of sortExtensionsByScope(params.extensions)) {
      if (collectResourceEntries([extension], params.scope).length === 0) {
        active.push(extension)
        continue
      }
      const built = yield* start(extension)
      if (Exit.isSuccess(built)) {
        context = Context.merge(context, built.value)
        active.push(extension)
        continue
      }
      const error = Cause.pretty(built.cause)
      yield* Effect.logError("extension.resource.failed").pipe(
        Effect.annotateLogs({ extensionId: extension.manifest.id, scope: params.scope, error }),
      )
      const fallback = params.fallback?.(extension, error) ?? Option.none()
      if (Option.isSome(fallback)) {
        const previous = yield* start(fallback.value)
        if (Exit.isSuccess(previous)) {
          context = Context.merge(context, previous.value)
          active.push(fallback.value)
          continue
        }
      }
      failed.push({
        extension,
        failure: toFailedExtension(extension, "startup", error),
        message: causeChainMessage(Cause.squash(built.cause)),
      })
    }
    return { active, failed, context }
  })

// ── host-platform ───────────────────────────────────────────────────────────

export const makeExtensionHostPlatform: Effect.Effect<ExtensionHostPlatform, never, GentPlatform> =
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    return {
      osInfo: yield* platform.osInfo,
      homeDirectory: yield* platform.homeDirectory,
      randomId: platform.randomId,
    }
  })

// ── loader ──────────────────────────────────────────────────────────────────

type LoadedUserExtension = GentExtension<ExtensionSetupServices>

// Discovery — scan directories for extension files

const EXTENSION_GLOBS = ["*.ts", "*.js", "*.mjs"]

const isExtensionFile = (entry: string): boolean =>
  !isClientFile(entry) &&
  EXTENSION_GLOBS.some((glob) => {
    const ext = glob.slice(1) // ".ts", ".js", ".mjs"
    return entry.endsWith(ext)
  })

/**
 * An extension file found on disk, its version, and its build: one module of
 * the file and every module it imports by a relative path (`buildEntry`).
 */
interface DiscoveredFile {
  readonly path: string
  /** The built module's content hash, or a failed build's (`!` and the error's hash). */
  readonly version: string
  /** The built module, or why the build failed. */
  readonly build: Result.Result<string, string>
}

/**
 * The last good build of one extension entry. `stamps` holds each input's
 * stat (`fileVersion`), so a resolve with no file touched reads no file;
 * `content` hashes each input's bytes, so a save of the same bytes builds
 * nothing.
 */
interface ModuleGraph {
  readonly stamps: ReadonlyMap<string, string>
  readonly content: string
  readonly version: string
  readonly code: string
}

/**
 * The module graphs of the extension entries this process built, by entry
 * path. The session profile cache owns one for the process, so a stat of
 * each input is all an unchanged extension costs a resolve. A failed build
 * is not kept: it builds again on the next resolve, so a relative module
 * created later is found.
 */
type ModuleGraphs = Map<string, ModuleGraph>

/** A file's stat stamp, or `missing` when it is gone. */
const statStamp = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map(fileVersion),
    Effect.orElseSucceed(() => "missing"),
  )

/**
 * The content hash of a build's inputs: each input's path and bytes, in path
 * order. A file that cannot be read hashes as missing, so it never matches.
 */
const contentHash = Effect.fn("ExtensionLoader.contentHash")(function* (
  inputs: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const platform = yield* GentPlatform
  const parts: string[] = []
  for (const input of inputs.toSorted(Order.String)) {
    const bytes = yield* fs.readFile(input).pipe(Effect.option)
    const digest = Option.match(bytes, {
      onNone: () => "missing",
      onSome: (content) => platform.hash("sha256", content),
    })
    parts.push(`${input}\u0000${digest}`)
  }
  return platform.hash("sha256", parts.join("\u0000"))
})

/**
 * How many times one resolve builds an entry before it gives up on a
 * coherent build: each try after the first follows an import the last try
 * found, or a save during the last try.
 */
const COHERENT_BUILD_TRIES = 3

/**
 * Build an extension entry into one module, or reuse its last build. Each
 * resolve stats the entry and the modules its last build read: no stat
 * changed, the last build stands. A stat changed but no byte did (a save of
 * the same bytes, a `touch`), the last build stands and the new stats are
 * kept. Otherwise the entry builds again. The version is the built module's
 * hash, so two builds of the same code share one version.
 *
 * A build is kept only when it is coherent: it read the files whose stats
 * and bytes were taken before it, and neither changed while it ran. A save
 * that comes and goes inside a build (A, then B, then A) leaves the bytes as
 * they were but not the stat: an atomic save is a new inode, an edit in place
 * a new mtime. A build that read a module not known before it, or that a save
 * overlapped, builds again with the inputs it found, so the first build of
 * an entry with relative imports builds twice. A build still not coherent
 * after `COHERENT_BUILD_TRIES` runs this resolve and is not kept, so the
 * next resolve builds again.
 */
const buildEntry = Effect.fn("ExtensionLoader.buildEntry")(function* (
  entry: string,
  graphs: ModuleGraphs,
) {
  const fs = yield* FileSystem.FileSystem
  const platform = yield* GentPlatform
  const known = Option.fromNullishOr(graphs.get(entry))
  let inputs = Option.match(known, {
    onNone: () => [entry],
    onSome: (graph) => [...graph.stamps.keys()],
  })
  const statAll = Effect.fn("ExtensionLoader.statInputs")(function* (files: ReadonlyArray<string>) {
    const stamps = new Map<string, string>()
    for (const input of files) stamps.set(input, yield* statStamp(fs, input))
    return stamps
  })
  const sameStamps = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) =>
    left.size === right.size && [...left].every(([input, stamp]) => right.get(input) === stamp)
  let stamps = yield* statAll(inputs)
  // An unchanged stat reads no input: only a changed one is hashed.
  if (Option.isSome(known) && sameStamps(stamps, known.value.stamps)) {
    return { version: known.value.version, build: Result.succeed(known.value.code) }
  }
  let content = yield* contentHash(inputs)
  if (Option.isSome(known) && content === known.value.content) {
    graphs.set(entry, { ...known.value, stamps })
    return { version: known.value.version, build: Result.succeed(known.value.code) }
  }
  for (let attempt = 1; ; attempt++) {
    const built = yield* platform.bundleModule(entry).pipe(Effect.result)
    if (Result.isFailure(built)) {
      const error = `Failed to build ${entry}: ${built.failure.message}`
      graphs.delete(entry)
      return {
        version: `!${platform.hash("sha256", error)}`,
        build: Result.fail(error),
      }
    }
    const version = platform.hash("sha256", built.success.code)
    const read = new Set(built.success.inputs)
    const sameInputs = read.size === inputs.length && inputs.every((input) => read.has(input))
    // The stats and bytes after the build match the ones before it, so no
    // save landed while it read them.
    const statsAfter = yield* statAll(built.success.inputs)
    const after = yield* contentHash(built.success.inputs)
    if (sameInputs && sameStamps(statsAfter, stamps) && after === content) {
      const graph: ModuleGraph = { stamps, content, version, code: built.success.code }
      graphs.set(entry, graph)
      return { version, build: Result.succeed(graph.code) }
    }
    if (attempt >= COHERENT_BUILD_TRIES) {
      graphs.delete(entry)
      return { version, build: Result.succeed(built.success.code) }
    }
    inputs = [...built.success.inputs]
    stamps = yield* statAll(inputs)
    content = yield* contentHash(inputs)
  }
})

/**
 * The extension files in a directory, sorted by path, each built
 * (`buildEntry`) when `graphs` is given, and the entries that could not be
 * read (a dangling symlink, a permission error). A directory whose code may
 * not load (an untrusted project) is listed, not built. It reports nothing;
 * `discoverDir` turns the unreadable entries into failures and the loader the
 * failed builds.
 */
const scanDir = Effect.fn("ExtensionLoader.scanDir")(function* (
  dir: string,
  graphs: Option.Option<ModuleGraphs>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const paths: DiscoveredFile[] = []
  const unreadable: Array<{ readonly path: string; readonly error: PlatformError.PlatformError }> =
    []

  const listed = yield* Effect.result(
    Effect.gen(function* () {
      if (!(yield* fs.exists(dir))) return []
      return yield* fs.readDirectory(dir)
    }),
  )
  if (Result.isFailure(listed)) {
    unreadable.push({ path: dir, error: listed.failure })
    return { paths, unreadable }
  }

  for (const entry of listed.success) {
    // Skip test directories, hidden files, and TUI extension files
    if (entry.startsWith(".") || entry.startsWith("_") || entry === "__tests__") continue
    if (isClientFile(entry)) continue

    const filePath = path.join(dir, entry)
    const found = yield* Effect.result(
      Effect.gen(function* () {
        const stat = yield* fs.stat(filePath)
        if (stat.type === "File" && isExtensionFile(entry)) return Option.some(filePath)
        if (stat.type !== "Directory") return Option.none<string>()
        // A directory extension is its index.ts/index.js/index.mjs.
        for (const indexName of ["index.ts", "index.js", "index.mjs"]) {
          const indexPath = path.join(filePath, indexName)
          if (yield* fs.exists(indexPath)) return Option.some(indexPath)
        }
        return Option.none<string>()
      }),
    )
    if (Result.isFailure(found)) {
      unreadable.push({ path: filePath, error: found.failure })
      continue
    }
    if (Option.isNone(found.success)) continue
    const entryPath = found.success.value
    if (Option.isNone(graphs)) {
      paths.push({ path: entryPath, version: "unbuilt", build: Result.fail("not built") })
      continue
    }
    paths.push({ path: entryPath, ...(yield* buildEntry(entryPath, graphs.value)) })
  }

  // Code-unit order, not the locale's: load order decides service conflicts.
  return { paths: paths.toSorted((a, b) => Order.String(a.path, b.path)), unreadable }
})

/**
 * A directory's scanned extension files, sorted by name. An entry that
 * cannot be read is a `load` failure for that path alone; its siblings are
 * still discovered.
 */
const discoverDir = Effect.fn("ExtensionLoader.discoverDir")(function* (
  scanned: DirScan,
  scope: ExtensionScope,
) {
  const path = yield* Path.Path
  const failed: FailedExtension[] = []
  for (const entry of scanned.unreadable) {
    const message = `Failed to read ${entry.path}: ${entry.error.message}`
    failed.push(importFailure(path, entry.path, scope, message))
    yield* Effect.logWarning("extension.discover.failed").pipe(
      Effect.annotateLogs({ path: entry.path, scope, error: message }),
    )
  }
  return { paths: scanned.paths, failed }
})

type DirScan = Effect.Success<ReturnType<typeof scanDir>>

/** The user and project extension directories a profile discovers. */
interface ExtensionDirectories {
  readonly userDir: string
  readonly projectDir: string
}

/**
 * One read of the extension directories and of the project's trust. A
 * profile is keyed on it (`extensionScanStamp`) and loaded from it, so its
 * key names exactly the file versions and the trust it loaded with.
 */
interface ExtensionScan {
  readonly dirs: ExtensionDirectories
  readonly user: DirScan
  readonly project: DirScan
  /** Whether the user config trusts the project root, so its scope may load. */
  readonly projectTrusted: boolean
}

/**
 * The extension directories a profile for these inputs reads, read once, with
 * the project's trust. Trust is read from the user config file now, by the
 * one reader the TUI uses too, so a grant or a revoke reaches the next scan,
 * and a user file that does not decode trusts no project: a revoke is never
 * undone by a broken edit.
 */
export const scanRuntimeProfileExtensions = Effect.fn("ExtensionLoader.scanExtensions")(function* (
  inputs: {
    readonly cwd: string
    readonly home: string
  },
  graphs: ModuleGraphs,
): Effect.fn.Return<ExtensionScan, never, FileSystem.FileSystem | Path.Path | GentPlatform> {
  const dirs = extensionDirectories(yield* Path.Path, inputs)
  const projectTrusted = yield* isProjectExtensionDirectoryTrusted(dirs)
  const user = yield* scanDir(dirs.userDir, Option.some(graphs))
  // Launched from home, the project directory is the user's: one scope, read once.
  let project: DirScan = { paths: [], unreadable: [] }
  if (yield* hasProjectScope({ user: dirs.userDir, project: dirs.projectDir }))
    project = yield* scanDir(
      dirs.projectDir,
      Option.filter(Option.some(graphs), () => projectTrusted),
    )
  return { dirs, user, project, projectTrusted }
})

/**
 * The extension files a scan found, each with its version, the paths that
 * failed to read, and the project's trust. A profile is keyed on it, so an
 * added, removed, fixed or edited extension file, and a trust grant or
 * revoke, reaches the next resolve.
 */
const extensionScanStamp = (scan: ExtensionScan): ReadonlyArray<string> => [
  ...[scan.user, scan.project].flatMap(({ paths, unreadable }) => [
    ...paths.map((file) => `${file.path}@${file.version}`),
    ...unreadable.map((entry) => `!${entry.path}`),
  ]),
  `?trusted=${String(scan.projectTrusted)}`,
]

/** The user and project extension directories a profile discovers. */
const extensionDirectories = (
  path: Path.Path,
  inputs: { readonly cwd: string; readonly home: string },
): ExtensionDirectories => ({
  userDir: path.join(inputs.home, GENT_CONFIG_DIRECTORY, "extensions"),
  projectDir: path.join(path.resolve(inputs.cwd), GENT_CONFIG_DIRECTORY, "extensions"),
})

// Loading — the public entries an extension file imports

/**
 * The specifiers an extension file imports, each bound to the module this
 * process already runs. The compiled binary has no node_modules, so without
 * this an extension outside the repository cannot resolve `effect` or a gent
 * entry. A bound specifier also gives a user extension the same module
 * instances as a shipped one: the same Tags and the same Schema classes.
 *
 * The loader binds the two authoring entries and `effect`. The host that
 * composes the shipped extensions binds the other `effect/*` and `@effect/*`
 * modules they import (`BuiltinExtensionModules` in `@gent/extensions`).
 * `@gent/core/protocol` is a client entry; the TUI binds it for client files
 * only. An internal path such as `@gent/core/host` is not bound, and it does
 * not resolve outside the repository.
 *
 * The gent entries re-export this module, so they are read on first use: a
 * static import here would evaluate them inside their own import cycle.
 */
// oxlint-disable-next-line effect/noDynamicImports -- the entry imports this module; read it after both evaluate
const loadExtensionApiEntry: RuntimeModuleSource = () => import("../extensions/api.js")
// oxlint-disable-next-line effect/noDynamicImports -- the entry imports this module; read it after both evaluate
const loadBranchToolsEntry: RuntimeModuleSource = () => import("../extensions/branch-tools.js")

export const extensionEntryModules: ReadonlyMap<string, RuntimeModuleSource> = new Map<
  string,
  RuntimeModuleSource
>([
  ["@gent/core/extensions/api", loadExtensionApiEntry],
  ["@gent/core/extensions/branch-tools", loadBranchToolsEntry],
  ["effect", () => EffectEntry],
])

/** Bind the extension entries before an extension file is imported. */
const provideExtensionModules: Effect.Effect<void, never, GentPlatform> = GentPlatform.use(
  (platform) => platform.bindModules(extensionEntryModules),
)

// Loading — import extension files via Bun native import()

// oxlint-disable-next-line effect/noDynamicImports -- extension modules are discovered from user/project files at runtime
const importExtensionModule = (filePath: string) => import(filePath)

/**
 * Load a single extension from its build (`buildEntry`). The platform serves
 * the built module at the file's path with its version in the query, so a
 * new version is imported afresh and the same version comes from Bun's module
 * cache: its top level runs once. The build holds every module the file
 * imports by a relative path, so an edit to one is a new version too. A
 * package import stays an import and resolves from the file's directory. Bun
 * never drops a module, so every version of an edited file stays in memory
 * until the process exits.
 */
const loadExtensionFile = Effect.fn("ExtensionLoader.loadExtensionFile")(function* (
  file: DiscoveredFile,
) {
  const filePath = file.path
  if (Result.isFailure(file.build)) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: file.build.failure,
    })
  }
  yield* provideExtensionModules
  const platform = yield* GentPlatform
  const specifier = `${filePath}?${SERVED_MODULE_QUERY}=${encodeURIComponent(file.version)}`
  yield* platform.serveModule(specifier, file.build.success)
  const mod = yield* Effect.tryPromise({
    try: () => importExtensionModule(specifier),
    catch: (err) =>
      new ExtensionLoadError({
        extensionId: ExtensionId.make("unknown"),
        message: `Failed to import ${filePath}: ${String(err)}`,
        cause: err,
      }),
  })

  // The module's extensions: `default` is one of its entries, and a value
  // exported under two names counts once.
  const [result, second] = new Set(Object.values(mod).filter(isGentExtension))

  if (Predicate.isUndefined(result)) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `No GentExtension found in ${filePath}. Export a defineExtension() result as default or named export.`,
    })
  }

  if (!Predicate.isUndefined(second)) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `Multiple GentExtension exports found in ${filePath}. Export exactly one.`,
    })
  }
  // Filesystem extensions are not trusted to name their own loaded artifact.
  // A package manifest can stay unchanged while the imported module changes,
  // and Bun can return a cached module after the file changes. Only a build
  // boundary may attach an artifact identity to a trusted builtin.
  const { artifactIdentity: _artifactIdentity, ...untrusted } = result
  return untrusted
})

const GentExtensionContract = Schema.Struct({
  manifest: Schema.Struct({ id: Schema.String }),
  setup: Schema.Unknown,
})
const decodeGentExtensionContract = Schema.decodeUnknownOption(GentExtensionContract)

/** Type guard for GentExtension shape */
const isGentExtension = (value: unknown): value is LoadedUserExtension => {
  const decoded = decodeGentExtensionContract(value)
  return Option.isSome(decoded) && Effect.isEffect(decoded.value.setup)
}

// Full discovery + loading pipeline

export interface DiscoveredExtension {
  readonly extension: LoadedUserExtension
  readonly scope: ExtensionScope
  readonly sourcePath: string
  /** The scanned file's version; a builtin has none. */
  readonly version?: string
}

/**
 * A file that never produced an extension has no manifest to read, so its id
 * comes from its path: the file name, or the directory name for an `index`
 * entry. That id also lets `disabledExtensions` silence it.
 */
const importFailure = (
  path: Path.Path,
  sourcePath: string,
  scope: ExtensionScope,
  error: string,
): FailedExtension => {
  const parsed = path.parse(sourcePath)
  let name = parsed.name
  if (name === "index") name = path.basename(parsed.dir)
  return { manifest: { id: ExtensionId.make(name) }, scope, sourcePath, phase: "load", error }
}

/**
 * A config file that did not load, as a `load` failure the extension health
 * view shows. Its settings are ignored until the file loads again. The reason
 * names the file: the id of both the user and the project file is `config`.
 */
const configLoadFailure = (
  path: Path.Path,
  home: string,
  error: ConfigLoadError,
): FailedExtension => {
  let scope: ExtensionScope = "project"
  if (error.path === path.join(home, ConfigService.CONFIG_RELATIVE)) scope = "user"
  return importFailure(
    path,
    error.path,
    scope,
    `${error.path} did not load; its settings are ignored until it is fixed: ${error.message}`,
  )
}

/**
 * The config files for `cwd` that do not load now, as health statuses. Health
 * reads the files on each call, not from the cached session profile, so a
 * fixed file clears its status without a restart.
 */
export const configHealthStatuses = Effect.fn("ExtensionHealth.configHealthStatuses")(function* (
  cwd: string,
) {
  const configService = yield* ConfigService
  const path = yield* Path.Path
  const environment = yield* RuntimeEnvironment
  const fresh = yield* configService.getFresh(cwd)
  return fresh.failures.map((failure) =>
    failedExtensionStatus(configLoadFailure(path, environment.home, failure)),
  )
})

/**
 * Load the extensions one scan found. Per-file isolation: one broken file
 * does not suppress its siblings.
 */
const loadExtensionScan = Effect.fn("ExtensionLoader.loadExtensionScan")(function* (
  scan: ExtensionScan,
) {
  const path = yield* Path.Path
  const user = yield* discoverDir(scan.user, "user")
  const project = yield* discoverDir(scan.project, "project")
  const userPaths = user.paths
  const projectPaths = project.paths
  const projectTrusted = scan.projectTrusted

  const loaded: DiscoveredExtension[] = []
  const failed: FailedExtension[] = [...user.failed]

  /** Load one scope's files; a broken file is skipped, its siblings still load. */
  const loadScope = Effect.fn("ExtensionLoader.loadScope")(function* (
    files: ReadonlyArray<DiscoveredFile>,
    scope: ExtensionScope,
  ) {
    for (const file of files) {
      const filePath = file.path
      const result = yield* loadExtensionFile(file).pipe(Effect.result)
      if (Result.isSuccess(result)) {
        loaded.push({
          extension: result.success,
          scope,
          sourcePath: filePath,
          version: file.version,
        })
        continue
      }
      const error = result.failure.message
      failed.push(importFailure(path, filePath, scope, error))
      yield* Effect.logWarning("extension.load.failed").pipe(
        Effect.annotateLogs({ path: filePath, scope, error }),
      )
    }
  })

  yield* loadScope(userPaths, "user")

  // The trust check guards the whole project scope, so it sits ahead of the loop.
  if (projectTrusted) {
    failed.push(...project.failed)
    yield* loadScope(projectPaths, "project")
  } else {
    const error =
      "Project code is not trusted. Add its canonical root to trustedProjects in the user config."
    for (const { path: filePath } of projectPaths) {
      failed.push(importFailure(path, filePath, "project", error))
      yield* Effect.logWarning("extension.load.untrusted").pipe(
        Effect.annotateLogs({ path: filePath, error }),
      )
    }
  }

  return { loaded, failed }
})

/** Run extension setup and produce LoadedExtension. Catches defects from malformed setup functions. */
export const setupExtension = Effect.fn("ExtensionLoader.setupExtension")(function* (
  discovered: DiscoveredExtension,
  cwd: string,
  home: string,
) {
  const host = yield* makeExtensionHostPlatform
  const manifest = discovered.extension.manifest
  const collector = makeCollectingExtensionHost({
    cwd,
    home,
    host,
  })
  const setupEffect = discovered.extension.setup.pipe(
    Effect.provideService(ExtensionHost, collector.service),
  )
  const setupResult: unknown = yield* sealRuntimeLoadedEffect({
    extensionId: manifest.id,
    effect: () => setupEffect,
    failureMessage: (cause) => `Extension setup failed: ${String(cause)}`,
    defectMessage: (cause) => `Extension setup defect: ${String(cause)}`,
  })
  // Contributions register through `ExtensionHost`; a setup that returns a value
  // meant to contribute it, and loading it as empty would drop it silently.
  if (!Predicate.isUndefined(setupResult)) {
    return yield* new ExtensionLoadError({
      extensionId: manifest.id,
      message:
        "Extension setup must return void; register tools, hooks, and other contributions through `yield* ExtensionHost` instead of returning them",
    })
  }
  const collected = yield* collector.seal
  // Requests carry their owning extension so RPC routing needs no lookup.
  let contributions: ExtensionContributions = collected
  if (!Predicate.isUndefined(collected.requests)) {
    contributions = {
      ...collected,
      requests: collected.requests.map((request) =>
        bindRequestCapabilityExtension(request, manifest.id),
      ),
    }
  }

  // Cross-bucket validation closes the install boundary: malformed
  // registrations fail activation, not mid-dispatch.
  yield* validateExtensionPackage(manifest, contributions)

  let loaded: LoadedExtension = {
    manifest: discovered.extension.manifest,
    scope: discovered.scope,
    sourcePath: discovered.sourcePath,
    contributions,
  }
  if (!Predicate.isUndefined(discovered.extension.artifactIdentity)) {
    loaded = { ...loaded, artifactIdentity: discovered.extension.artifactIdentity }
  }
  if (!Predicate.isUndefined(discovered.version)) {
    loaded = { ...loaded, version: discovered.version }
  }
  return loaded
})

// ── activation ──────────────────────────────────────────────────────────────

interface ExtensionActivationResult {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
}

const toFailedExtension = (
  ext: {
    manifest: LoadedExtension["manifest"]
    scope: LoadedExtension["scope"]
    sourcePath: string
  },
  phase: FailedExtensionPhase,
  error: string,
): FailedExtension => ({
  manifest: ext.manifest,
  scope: ext.scope,
  sourcePath: ext.sourcePath,
  phase,
  error,
})

/** Set up extensions, and the ones the disabled list named, which were not. */
interface ExtensionSetupResult extends ExtensionActivationResult {
  readonly disabled: ReadonlyArray<DisabledExtension>
}

export const setupExtensions = (params: {
  readonly extensions: ReadonlyArray<DiscoveredExtension>
  readonly cwd: string
  readonly home: string
  readonly disabled: ReadonlySet<string>
}): Effect.Effect<ExtensionSetupResult, never, ExtensionLoaderServices> =>
  Effect.gen(function* () {
    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []
    const disabled: DisabledExtension[] = []

    for (const discovered of params.extensions) {
      if (params.disabled.has(discovered.extension.manifest.id)) {
        disabled.push({
          manifest: discovered.extension.manifest,
          scope: discovered.scope,
          sourcePath: discovered.sourcePath,
        })
        yield* Effect.logDebug("extension.setup.skipped.disabled").pipe(
          Effect.annotateLogs({
            extensionId: discovered.extension.manifest.id,
            scope: discovered.scope,
          }),
        )
        continue
      }

      const exit = yield* setupExtension(discovered, params.cwd, params.home).pipe(Effect.exit)
      if (exit._tag === "Success") {
        active.push(exit.value)
        yield* Effect.logDebug("extension.setup.ok").pipe(
          Effect.annotateLogs({
            extensionId: discovered.extension.manifest.id,
            scope: discovered.scope,
            tools: (exit.value.contributions.tools ?? []).length,
          }),
        )
      } else {
        const error = causeMessage(Cause.squash(exit.cause))
        failed.push(
          toFailedExtension(
            {
              manifest: discovered.extension.manifest,
              scope: discovered.scope,
              sourcePath: discovered.sourcePath,
            },
            "setup",
            error,
          ),
        )
        yield* Effect.logWarning("extension.setup.failed").pipe(
          Effect.annotateLogs({
            extensionId: discovered.extension.manifest.id,
            scope: discovered.scope,
            sourcePath: discovered.sourcePath,
            error,
          }),
        )
      }
    }

    return { active, failed, disabled }
  })

const extensionKey = (ext: Pick<LoadedExtension, "scope" | "manifest" | "sourcePath">) =>
  `${ext.scope}:${ext.manifest.id}:${ext.sourcePath}`

const formatConflicts = (
  label: string,
  scope: LoadedExtension["scope"],
  key: string,
  extensions: ReadonlyArray<LoadedExtension>,
) =>
  `Ambiguous ${label} "${key}" in scope "${scope}" across ${extensions
    .map((ext) => `"${ext.manifest.id}"`)
    .join(", ")}`

const collectDuplicateExtensionIds = (
  extensions: ReadonlyArray<LoadedExtension>,
  addFailure: (extension: LoadedExtension, error: string) => void,
): void => {
  const idsByScope = new Map<LoadedExtension["scope"], Map<string, LoadedExtension[]>>()
  for (const extension of extensions) {
    const scopeMap = idsByScope.get(extension.scope) ?? new Map<string, LoadedExtension[]>()
    const sameId = scopeMap.get(extension.manifest.id) ?? []
    sameId.push(extension)
    scopeMap.set(extension.manifest.id, sameId)
    idsByScope.set(extension.scope, scopeMap)
  }
  for (const [scope, scopeMap] of idsByScope) {
    for (const [id, sameId] of scopeMap) {
      if (sameId.length <= 1) continue
      const error = `Duplicate extension id "${id}" in scope "${scope}"`
      for (const extension of sameId) addFailure(extension, error)
    }
  }
}

const collectValidationFailures = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyMap<string, { ext: LoadedExtension; errors: ReadonlyArray<string> }> => {
  const failures = new Map<string, { ext: LoadedExtension; errors: string[] }>()

  const addFailure = (ext: LoadedExtension, error: string) => {
    const key = extensionKey(ext)
    const current = failures.get(key)
    if (Predicate.isUndefined(current)) {
      failures.set(key, { ext, errors: [error] })
      return
    }
    if (!current.errors.includes(error)) current.errors.push(error)
  }

  collectDuplicateExtensionIds(extensions, addFailure)

  const collectScopedCollisions = <T>(
    pickItems: (contribs: ExtensionContributions) => ReadonlyArray<T>,
    getKey: (item: T) => Option.Option<string>,
    label: string,
  ) => {
    const byScope = new Map<LoadedExtension["scope"], Map<string, LoadedExtension[]>>()
    for (const ext of extensions) {
      const scopeMap = byScope.get(ext.scope) ?? new Map<string, LoadedExtension[]>()
      // A key named twice by one extension is a package error that
      // `validateExtensionPackage` owns; here each extension counts once per key.
      for (const item of pickItems(ext.contributions)) {
        const key = getKey(item)
        if (Option.isNone(key)) continue
        const existing = scopeMap.get(key.value) ?? []
        if (existing.includes(ext)) continue
        existing.push(ext)
        scopeMap.set(key.value, existing)
      }
      byScope.set(ext.scope, scopeMap)
    }

    for (const [scope, scopeMap] of byScope) {
      for (const [key, sameKey] of scopeMap) {
        if (sameKey.length <= 1) continue
        const error = formatConflicts(label, scope, key, sameKey)
        for (const ext of sameKey) addFailure(ext, error)
      }
    }
  }

  // Tools and requests share one id namespace, as `compileCapabilityWinners`
  // keeps one winner per id: a same-scope tool and request with one id fail
  // together instead of one silently hiding the other.
  collectScopedCollisions(
    (cs): ReadonlyArray<string> => [
      ...(cs.tools ?? []).filter(isToolCapability).map((cap) => String(getToolMetadata(cap).id)),
      ...(cs.requests ?? []).map((cap) => String(cap.id)),
    ],
    Option.some,
    "capability",
  )
  collectScopedCollisions(
    (cs) => cs.agents ?? [],
    (agent) => Option.some(agent.name),
    "agent",
  )
  collectScopedCollisions(
    (cs) => cs.modelDrivers ?? [],
    (driver) => Option.some(driver.id),
    "model driver",
  )
  collectScopedCollisions(
    (cs) => cs.apiClasses ?? [],
    (apiClass) => Option.some(apiClass.id),
    "API class",
  )
  collectScopedCollisions(
    (cs) => cs.modelRouters ?? [],
    (router) => Option.some(router.id),
    "model router",
  )

  return failures
}

export const validateLoadedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): Effect.Effect<ExtensionActivationResult> =>
  Effect.sync(() => {
    const failures = collectValidationFailures(extensions)
    if (failures.size === 0) return { active: [...extensions], failed: [] }

    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []
    for (const ext of extensions) {
      const failure = failures.get(extensionKey(ext))
      if (Predicate.isUndefined(failure)) {
        active.push(ext)
        continue
      }
      failed.push(toFailedExtension(ext, "validation", failure.errors.join("; ")))
    }
    return { active, failed }
  })

// ── profile ─────────────────────────────────────────────────────────────────

/** Profile declarations, catalog assembly, and isolated child resource wiring. */

/**
 * Inputs that fully describe a runtime profile.
 *
 * `cwd` is the only per-call axis; everything else is composition-root configuration
 * (home dir, platform metadata, builtin extensions).
 */
export interface RuntimeProfileInputs {
  readonly cwd: string
  readonly home: string
  readonly platform: string
  readonly shell?: string
  readonly osVersion?: string
  readonly extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /**
   * Every extension this profile must not activate. The caller has already
   * merged the user and project config into it, so this loader reads no
   * config file of its own.
   */
  readonly disabledExtensions?: ReadonlyArray<string>
}

/**
 * Heterogeneous services contributed by authored process resources. The host
 * membrane owns this erased context instead of naming a closed-world service
 * union here.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Resource services are heterogeneous at this explicit host membrane.
type RuntimeProfileServiceContext = Context.Context<any>

/** Services and immutable prompt inputs built for one session. */
export interface SessionProfile {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly layerContext: RuntimeProfileServiceContext
  readonly registryService: ExtensionRegistryService
  readonly baseSections: ReadonlyArray<PromptSection>
  /**
   * Identity of the process that built this profile. A process-local tool
   * binding is replayable only inside it.
   */
  readonly generationId: ProcessGenerationId
}

/**
 * Extension declarations and prompt inputs loaded before process resources are
 * acquired.
 *
 * Extension setup is trusted code and can perform its own ordinary effects.
 * This boundary only guarantees that it does not build Resource layers.
 */
interface RuntimeProfileDeclarations {
  readonly extensionDeclarations: ExtensionActivationResult
  /** Found and named by the disabled list, so never set up. */
  readonly disabledExtensions: ReadonlyArray<DisabledExtension>
  readonly coreSections: ReadonlyArray<PromptSection>
}

/**
 * The last good version of the extension a failure names, by its scope and
 * source path (`SessionProfileCache`): none when it never loaded, was deleted
 * or was disabled since.
 */
type LastGoodLookup = (failure: FailedExtension) => Option.Option<LoadedExtension>

const sameSource = (
  extension: Pick<LoadedExtension, "scope" | "sourcePath">,
  failure: Pick<FailedExtension, "scope" | "sourcePath">,
): boolean => extension.scope === failure.scope && extension.sourcePath === failure.sourcePath

/**
 * Load, set up and validate a profile's extensions. A user or project
 * extension whose new version fails to load, set up or validate runs its last
 * good version (`lastGood`) instead, marked with the failure
 * (`LoadedExtension.reloadFailed`), when the set stays valid with it. A
 * project the user does not trust keeps nothing: a revoke is a removal.
 */
export const loadRuntimeProfileDeclarations = (
  inputs: RuntimeProfileInputs,
  scan: ExtensionScan,
  lastGood: LastGoodLookup = () => Option.none(),
): Effect.Effect<RuntimeProfileDeclarations, never, ExtensionLoaderServices> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const canonicalCwd = path.resolve(inputs.cwd)

    // 1. Disabled set, already merged by the caller
    const disabledSet = new Set(inputs.disabledExtensions ?? [])

    // 2. Discover external extensions (user + project dirs)
    const discovery = yield* loadExtensionScan(scan).pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("runtime-profile.extension.discovery.failed").pipe(
          Effect.annotateLogs({ error: String(error), cwd: canonicalCwd }),
          Effect.as({ loaded: [], failed: [] }),
        ),
      ),
    )
    const importFailed = discovery.failed.filter((ext) => !disabledSet.has(ext.manifest.id))
    const importDisabled = discovery.failed.flatMap(({ manifest, scope, sourcePath }) => {
      if (!disabledSet.has(manifest.id)) return []
      return [{ manifest, scope, sourcePath } satisfies DisabledExtension]
    })

    // 3. Setup builtin + external extensions
    const setup = yield* setupExtensions({
      extensions: [
        ...inputs.extensions.map((extension): DiscoveredExtension => ({
          extension,
          scope: "builtin",
          sourcePath: "builtin",
        })),
        ...discovery.loaded,
      ],
      cwd: canonicalCwd,
      home: inputs.home,
      disabled: disabledSet,
    })

    // 4. A new version that failed to load or set up runs its last good one.
    const fallbackFor = (failure: FailedExtension): Option.Option<LoadedExtension> => {
      if (failure.scope === "builtin") return Option.none()
      if (failure.scope === "project" && !scan.projectTrusted) return Option.none()
      // A disable names the manifest id, which a file that did not load lacks.
      return lastGood(failure).pipe(
        Option.filter((previous) => !disabledSet.has(previous.manifest.id)),
        Option.map((previous) => ({
          ...previous,
          reloadFailed: { phase: failure.phase, error: failure.error },
        })),
      )
    }
    // Each last good version, and the failure it stands for.
    const standsFor = new Map<LoadedExtension, FailedExtension>()
    const kept: LoadedExtension[] = []
    const failedBeforeValidation: FailedExtension[] = []
    for (const failure of [...importFailed, ...setup.failed]) {
      const fallback = fallbackFor(failure)
      if (Option.isNone(fallback)) {
        failedBeforeValidation.push(failure)
        continue
      }
      kept.push(fallback.value)
      standsFor.set(fallback.value, failure)
    }

    // 5. Validate declarations without acquiring process resources. The new
    // versions validate among themselves first. One that fails runs its last
    // good version, if that is another version.
    const fresh = yield* validateLoadedExtensions(setup.active)
    const replaced = new Map<LoadedExtension, LoadedExtension>()
    for (const failure of fresh.failed) {
      const failedFresh = Option.fromNullishOr(
        setup.active.find((extension) => sameSource(extension, failure)),
      )
      if (Option.isNone(failedFresh)) continue
      const fallback = fallbackFor(failure)
      if (Option.isNone(fallback) || fallback.value.version === failedFresh.value.version) continue
      replaced.set(failedFresh.value, fallback.value)
      standsFor.set(fallback.value, failure)
    }
    // A last good version runs only in a set it is valid in: one that
    // collides leaves the set, its extension fails as its new version did,
    // and the set validates again without it. So a last good version never
    // takes down an extension whose new version is good.
    let candidates = [
      ...setup.active.map((extension) => replaced.get(extension) ?? extension),
      ...kept,
    ]
    let extensionDeclarations = yield* validateLoadedExtensions(candidates)
    const rejected: FailedExtension[] = []
    for (;;) {
      const colliding = candidates.filter(
        (extension) =>
          standsFor.has(extension) &&
          extensionDeclarations.failed.some((failure) => sameSource(extension, failure)),
      )
      if (colliding.length === 0) break
      for (const fallback of colliding) {
        const failure = standsFor.get(fallback)
        if (!Predicate.isUndefined(failure)) rejected.push(failure)
      }
      candidates = candidates.filter((extension) => !colliding.includes(extension))
      extensionDeclarations = yield* validateLoadedExtensions(candidates)
    }
    const declarations: ExtensionActivationResult = {
      active: extensionDeclarations.active,
      failed: [...failedBeforeValidation, ...rejected, ...extensionDeclarations.failed],
    }
    // 6. Build the base prompt section: core writes the environment
    const isGitRepo = yield* fs
      .exists(path.join(canonicalCwd, ".git"))
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    const coreSections = [
      environmentSection({
        cwd: canonicalCwd,
        platform: inputs.platform,
        shell: inputs.shell,
        osVersion: inputs.osVersion,
        isGitRepo,
      }),
    ]

    return {
      extensionDeclarations: declarations,
      disabledExtensions: [...setup.disabled, ...importDisabled],
      coreSections,
    }
  })

/**
 * Build a session profile from a context whose resources are already built.
 * This function only assembles services. It never invokes a resource layer.
 */
const buildSessionProfile = (params: {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly coreSections: ReadonlyArray<PromptSection>
  readonly resourceContext: Context.Context<unknown>
  readonly generationId: ProcessGenerationId
  readonly providerConfig: Effect.Effect<ProviderConfig>
}) =>
  Effect.gen(function* () {
    // Every resource is already built. Supplying that immutable context here is
    // the only resource-side operation in staging.
    // oxlint-disable-next-line typescript/no-explicit-any -- The host membrane erases heterogeneous resource services at this boundary.
    const resourceLayer: Layer.Layer<any, never, never> = Layer.succeedContext(
      params.resourceContext,
    )
    const layerContext = yield* Layer.build(
      Layer.provideMerge(
        resourceLayer,
        ExtensionRegistry.fromResolved(params.resolved, params.providerConfig),
      ),
    )
    return {
      cwd: params.cwd,
      resolved: params.resolved,
      layerContext,
      registryService: Context.get(layerContext, ExtensionRegistry),
      baseSections: params.coreSections,
      generationId: params.generationId,
    } satisfies SessionProfile
  })

// ── session-profile ─────────────────────────────────────────────────────────

/**
 * SessionProfile — per-(workspace,cwd) live profile: one server serves many workspaces.
 *
 * Each cache entry is built once. Declarations are loaded, every extension's
 * process resources share a scope across compatible profiles, closing when
 * their last holder retires or the server closes. The catalog is staged from
 * the resulting context. An extension whose process
 * resource fails to build is reported as a failed extension and the rest of the
 * profile stays live.
 */

// ── session profile cache ───────────────────────────────────────────────────

interface SessionProfileCacheConfig {
  readonly home: string
  readonly platform: string
  readonly shell?: string
  readonly osVersion?: string
  readonly extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
  /**
   * A failed extension stops the profile build instead of leaving the rest
   * live. Production keeps going so one broken user extension cannot take the
   * server down; test roots turn this on, because there a failed extension is
   * an authoring bug that otherwise shows up as an unrelated timeout.
   */
  readonly failOnExtensionFailure: boolean
}

/** One line per failed extension: which one, in which phase, and why. */
const describeFailedExtensions = (failed: ReadonlyArray<FailedExtension>): string =>
  [
    "Extensions failed to load:",
    ...failed.map(
      (entry) => `- ${entry.manifest.id} (${entry.scope}, ${entry.phase}): ${entry.error}`,
    ),
  ].join("\n")

export interface SessionProfileCacheService {
  /**
   * The profile for the given cwd under the config as it is now: found, or
   * built on first use. The caller's scope holds a lease on it: a profile a
   * later config edit superseded closes when its last lease is released.
   */
  readonly resolve: (cwd: string) => Effect.Effect<SessionProfile, never, ScopeType.Scope>
  /**
   * Make the next `resolve` for the cwd set up its extensions again, though
   * no file or config changed. The new profile keeps each extension's
   * process Resources whose build key it shares. The count lives in memory
   * only: a restart sets everything up anyway.
   */
  readonly reload: (cwd: string, id: ExtensionId) => Effect.Effect<void>
}

/** One (workspace, cwd) place: at most one current profile, one build lock. */
const placeKey = (workspaceId: WorkspaceId, cwd: string): string =>
  [workspaceId, cwd].join("\u0000")

/**
 * The raw disabled list as the config names it, and the extension files on
 * disk (`extensionScanStamp`). It only finds a profile the same inputs
 * resolved before; the profile itself is keyed by `profileKey`.
 */
const listKey = (
  place: string,
  disabledExtensions: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
): string => [place, ...[...new Set(disabledExtensions)].toSorted(), "", ...files].join("\u0000")

/**
 * A profile is derived from its place, the extensions its config leaves set
 * up, and the files they load from, so the key holds the active and the
 * failed extension ids and the file versions, not the disabled list: an id
 * no extension has builds no second profile, and an edited file builds one.
 * An extension that runs its last good version names that version too.
 */
const profileKey = (
  place: string,
  declarations: ExtensionActivationResult,
  files: ReadonlyArray<string>,
): string =>
  [
    place,
    // A last good version runs in place of the file's: the key names it.
    ...declarations.active
      .map((extension) => {
        if (Predicate.isUndefined(extension.reloadFailed)) return `+${extension.manifest.id}`
        const version = Option.getOrElse(Option.fromUndefinedOr(extension.version), () => "")
        return `+${extension.manifest.id}~${version}`
      })
      .toSorted(),
    ...declarations.failed.map((extension) => `!${extension.manifest.id}`).toSorted(),
    "",
    ...files,
  ].join("\u0000")

/** The profile inputs with the merged user and project config's disabled list. */
const effectiveInputs = (
  inputs: RuntimeProfileInputs,
  config: UserConfig,
): RuntimeProfileInputs => ({
  ...inputs,
  disabledExtensions: Option.getOrElse(Option.fromUndefinedOr(config.disabledExtensions), () => []),
})

interface StartedProcessResources {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
  readonly context: Context.Context<unknown>
}

export class SessionProfileCache extends Context.Service<
  SessionProfileCache,
  SessionProfileCacheService
>()("@gent/core/src/runtime/extension-host/SessionProfileCache") {
  static Live = (
    config: SessionProfileCacheConfig,
  ): Layer.Layer<
    SessionProfileCache,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner
    | Crypto.Crypto
    | ConfigService
    | GentPlatform
  > =>
    Layer.effect(
      SessionProfileCache,
      Effect.gen(function* () {
        const configService = yield* ConfigService
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const spawner = yield* ChildProcessSpawner
        const crypto = yield* Crypto.Crypto
        const platform = yield* GentPlatform
        // Every profile's resources close with this server scope.
        const serverScope = yield* Scope.Scope
        const generationId = ProcessGenerationId.make(yield* platform.randomId)

        const platformServicesContext: Context.Context<unknown> = Context.makeUnsafe<unknown>(
          new Map(),
        ).pipe(
          Context.add(FileSystem.FileSystem, fs),
          Context.add(Path.Path, pathSvc),
          Context.add(ChildProcessSpawner, spawner),
          Context.add(Crypto.Crypto, crypto),
          Context.add(ConfigService, configService),
          Context.add(GentPlatform, platform),
        )

        interface ProfileEntry {
          /** The declaration key and the last good versions the build decided by. */
          readonly key: string
          /** `profileKey`: the place, the declared extensions and their files. */
          readonly declarationKey: string
          /** `consultedLastGood`: last good key to the version under it at the build. */
          readonly consulted: ReadonlyMap<string, string>
          readonly place: string
          readonly profile: SessionProfile
          readonly scope: Scope.Closeable
          /** The shared process resources the profile holds (`sharedResources`). */
          readonly resources: ReadonlyArray<string>
        }
        // Every map below changes only under the place's lock. A shared
        // resource's key starts with its place, so its place's lock guards it.
        const entries = new Map<string, ProfileEntry>()
        const leases = new Map<string, number>()
        // One extension's process resources, shared by every profile that
        // builds them over the same context (`startProcessResources`), with
        // the number of profiles that hold them.
        const sharedResources = new Map<
          string,
          {
            readonly scope: Scope.Closeable
            readonly context: Context.Context<unknown>
            holders: number
          }
        >()
        // A raw disabled list seen before, to the profile it resolved to.
        const aliases = new Map<string, string>()
        // How many times each extension of a place was reloaded. The counts
        // join the file stamp, so a reload misses both the alias and the
        // profile and builds a new profile.
        const reloads = new Map<string, Map<string, number>>()
        // Each extension entry's last good build, shared by every place: an
        // unchanged extension costs a resolve a stat of each file it built from.
        const graphs: ModuleGraphs = new Map()
        // The last version of each user and project extension of a place
        // that ran, by place, scope and source path. A newer version that
        // fails runs this one in its place (`loadRuntimeProfileDeclarations`,
        // `startProcessResources`). A deleted file or a disabled id leaves the
        // profile, so it leaves this map too.
        const lastGood = new Map<string, LoadedExtension>()
        const lastGoodKey = (
          place: string,
          source: Pick<LoadedExtension, "scope" | "sourcePath">,
        ): string => [place, source.scope, source.sourcePath].join("\u0000")
        const lastGoodFor =
          (place: string): LastGoodLookup =>
          (failure) =>
            Option.fromNullishOr(lastGood.get(lastGoodKey(place, failure)))
        /**
         * Keep each extension the place's current profile runs as its last
         * good version, and forget the ones it no longer has.
         */
        const recordLastGood = (place: string, resolved: ResolvedExtensions) => {
          const present = new Set<string>()
          for (const extension of resolved.extensions) {
            if (extension.scope === "builtin") continue
            const key = lastGoodKey(place, extension)
            present.add(key)
            if (Predicate.isUndefined(extension.reloadFailed)) lastGood.set(key, extension)
          }
          for (const failure of resolved.failedExtensions) present.add(lastGoodKey(place, failure))
          for (const key of lastGood.keys()) {
            if (key.startsWith(`${place}\u0000`) && !present.has(key)) lastGood.delete(key)
          }
        }
        /** The version the last good map holds under a key, `-` for none. */
        const lastGoodVersion = (key: string): string =>
          Option.match(Option.fromNullishOr(lastGood.get(key)), {
            onNone: () => "-",
            onSome: (extension) => extension.version ?? "",
          })
        /**
         * The last good versions a profile's build decided by: for each user
         * or project extension that runs a last good version or failed, its
         * last good key (place, scope, source path) and the version under it
         * then. A last good version that ran, was rejected for a collision, or
         * failed to start is in it, and so is the lack of one.
         */
        const consultedLastGood = (
          place: string,
          resolved: ResolvedExtensions,
        ): ReadonlyMap<string, string> => {
          const decided: Array<Pick<LoadedExtension, "scope" | "sourcePath">> = [
            ...resolved.extensions.filter(
              (extension) => !Predicate.isUndefined(extension.reloadFailed),
            ),
            ...resolved.failedExtensions,
          ]
          return new Map(
            decided.flatMap((extension) => {
              if (extension.scope === "builtin") return []
              const key = lastGoodKey(place, extension)
              return [[key, lastGoodVersion(key)] as const]
            }),
          )
        }
        /**
         * A profile serves a resolve only while each last good version its
         * build decided by is still the one under its key: after a newer
         * version ran, the same failure decides again, and may run the newer
         * one. A profile a turn holds outlives that change, so the lookup
         * checks it, by alias or by key.
         */
        const runsCurrentLastGood = (entry: ProfileEntry): boolean =>
          [...entry.consulted].every(([key, version]) => lastGoodVersion(key) === version)
        /**
         * The part of a profile's identity its declarations do not hold
         * (`profileKey`): the last good versions it decided by, each named by
         * scope and source, since a user and a project extension can share
         * an id.
         */
        const consultedKey = (consulted: ReadonlyMap<string, string>): string =>
          [...consulted]
            .map(([key, version]) => [key, version].join("\u0000"))
            .toSorted()
            .join("\u0002")
        const filesStamp = (place: string, scan: ExtensionScan): ReadonlyArray<string> => [
          ...extensionScanStamp(scan),
          ...Array.from(reloads.get(place) ?? new Map<string, number>())
            .map(([id, count]) => `reload:${id}#${count}`)
            .toSorted(),
        ]
        // The profile the place's config selects now. Only a superseded
        // profile retires; the current one stays cached without a lease.
        const current = new Map<string, string>()
        // The gate only protects creation of per-place locks. Building one cwd
        // must not block unrelated cwd or workspace places.
        const locks = new Map<string, Semaphore.Semaphore>()
        const lockGate = yield* Semaphore.make(1)
        const lockFor = (place: string) =>
          Effect.gen(function* () {
            const existing = Option.fromNullishOr(locks.get(place))
            if (Option.isSome(existing)) return existing.value
            const created = yield* Semaphore.make(1)
            locks.set(place, created)
            return created
          }).pipe(lockGate.withPermits(1))

        const inputsFor = (cwd: string): RuntimeProfileInputs => ({
          cwd,
          home: config.home,
          platform: config.platform,
          shell: config.shell,
          osVersion: config.osVersion,
          extensions: config.extensions,
        })

        /**
         * Let go of shared resources a profile held. The ones no profile holds
         * any more are returned for the caller to close.
         */
        const dropResources = (keys: ReadonlyArray<string>): ReadonlyArray<Scope.Closeable> =>
          keys.toReversed().flatMap((key) => {
            const shared = Option.fromNullishOr(sharedResources.get(key))
            if (Option.isNone(shared)) return []
            shared.value.holders -= 1
            if (shared.value.holders > 0) return []
            sharedResources.delete(key)
            return [shared.value.scope]
          })

        const closeScopes = (scopes: ReadonlyArray<Scope.Closeable>) =>
          Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true })

        /**
         * Build every extension's process resources in resolution order, so
         * a later extension's service wins exactly as it does in the
         * registry. An extension's resources are shared by every profile of
         * the place that builds them over the same context: the same
         * resource-bearing extensions before it and itself (id, source and
         * file version). A profile rebuilt for an edit that leaves them alone
         * keeps them, and with them their state: an open `/btw` fork, a
         * watcher, a running job. They close when the last profile holding
         * them retires. A resource that fails to build is not shared: its
         * extension is reported as failed at the startup phase, and the rest
         * of the profile stays live. Only a build can be interrupted; each
         * key it shares or builds is pushed to `held` at once, so the caller
         * can let go of it.
         */
        const startProcessResources = (
          place: string,
          extensions: ReadonlyArray<LoadedExtension>,
          held: Array<string>,
          restore: Restore,
        ): Effect.Effect<StartedProcessResources> =>
          Effect.gen(function* () {
            // The key of a build is the identities of the builds it runs over,
            // as they started: a last good version that runs in place of a
            // version that failed to start is named by its own version, and a
            // build after it by that version too (`resourceBuildKeys` names
            // what the set declares, not what started). `buildScopeResources`
            // shares or builds one extension at a time in resolution order,
            // and each one it shares or builds is live over the ones before.
            const chain = [place]
            const keyOf = (extension: LoadedExtension) =>
              [...chain, extensionResourceIdentity(extension)].join("\u0000")
            const accept = (extension: LoadedExtension, key: string) => {
              chain.push(extensionResourceIdentity(extension))
              held.push(key)
            }
            // The set as it runs: each last good version in place of the
            // version it stands for.
            let effective = extensions
            const started = yield* buildScopeResources({
              extensions,
              scope: "process",
              context: platformServicesContext,
              parent: serverScope,
              restore,
              reuse: (extension) => {
                const key = keyOf(extension)
                const shared = Option.fromNullishOr(sharedResources.get(key))
                if (Option.isNone(shared)) return Option.none()
                shared.value.holders += 1
                accept(extension, key)
                return Option.some(shared.value.context)
              },
              built: (extension, scope, context) => {
                const key = keyOf(extension)
                sharedResources.set(key, { scope, context, holders: 1 })
                accept(extension, key)
              },
              // A last good version runs only where its contributions collide
              // with none of the set's: the set validated without it, so a
              // collision is its own, and the extension whose new version
              // failed is the one that fails.
              fallback: (extension, error) => {
                if (extension.scope === "builtin") return Option.none()
                return Option.fromNullishOr(lastGood.get(lastGoodKey(place, extension))).pipe(
                  Option.filter((previous) => previous.version !== extension.version),
                  Option.map((previous): LoadedExtension => ({
                    ...previous,
                    reloadFailed: { phase: "startup", error },
                  })),
                  Option.filter((previous) => {
                    const substituted = effective.map((other) => {
                      if (sameSource(other, extension)) return previous
                      return other
                    })
                    if (collectValidationFailures(substituted).size > 0) return false
                    effective = substituted
                    return true
                  }),
                )
              },
            })
            return {
              active: started.active,
              failed: started.failed.map(({ failure }) => failure),
              context: started.context,
            }
          })

        /**
         * Build a profile into a new scope. The caller runs this where it
         * cannot be interrupted; only a resource build and the registry
         * build (`restore`) can be. A failed or interrupted build closes its
         * scope and lets go of the shared resources it took.
         */
        const buildProfile = (
          place: string,
          cwd: string,
          fresh: FreshConfig,
          declarations: RuntimeProfileDeclarations,
          restore: Restore,
        ) =>
          Effect.gen(function* () {
            const profileScope = yield* Scope.fork(serverScope)
            const held: Array<string> = []
            const profile = yield* Effect.gen(function* () {
              const started = yield* startProcessResources(
                place,
                declarations.extensionDeclarations.active,
                held,
                restore,
              )
              // A config failure is not part of the profile: health reads it
              // live (`configHealthStatuses`), so it clears when the file is
              // fixed. A root that fails on any failure still sees it here.
              const resolved = resolveExtensions(
                started.active,
                [...declarations.extensionDeclarations.failed, ...started.failed],
                declarations.disabledExtensions,
              )
              const buildFailures = [
                ...fresh.failures.map((failure) =>
                  configLoadFailure(pathSvc, config.home, failure),
                ),
                ...resolved.failedExtensions,
                // A new version that failed is an authoring bug even when
                // its last good version runs.
                ...resolved.extensions.flatMap((extension) =>
                  Option.match(Option.fromUndefinedOr(extension.reloadFailed), {
                    onNone: () => [],
                    onSome: ({ phase, error }) => [toFailedExtension(extension, phase, error)],
                  }),
                ),
              ]
              if (config.failOnExtensionFailure && buildFailures.length > 0) {
                return yield* Effect.die(describeFailedExtensions(buildFailures))
              }
              return yield* restore(
                buildSessionProfile({
                  cwd,
                  resolved,
                  coreSections: declarations.coreSections,
                  resourceContext: started.context,
                  generationId,
                  providerConfig: Effect.map(configService.get(cwd), (current) => ({
                    providers: current.providers,
                    disabledProviders: current.disabledProviders,
                  })),
                }),
              )
            }).pipe(
              Effect.provideService(Scope.Scope, profileScope),
              // A failed or interrupted build releases everything it acquired.
              Effect.onError((cause) =>
                Scope.close(profileScope, Exit.failCause(cause)).pipe(
                  Effect.andThen(closeScopes(dropResources(held))),
                ),
              ),
            )
            return { profile, scope: profileScope, resources: held }
          })

        /**
         * The profile for a raw list: aliased, found by its extensions, or
         * built. It runs where it cannot be interrupted, so an entry it
         * stores is always leased by the caller; only the reads and the build
         * (`restore`) can be interrupted, and they store nothing.
         */
        const entryFor = (
          place: string,
          list: string,
          scan: ExtensionScan,
          cwd: string,
          fresh: FreshConfig,
          restore: Restore,
        ) =>
          Effect.gen(function* () {
            const aliased = Option.flatMap(Option.fromNullishOr(aliases.get(list)), (key) =>
              Option.fromNullishOr(entries.get(key)),
            ).pipe(Option.filter(runsCurrentLastGood))
            if (Option.isSome(aliased)) return aliased.value
            const files = filesStamp(place, scan)
            const declarations = yield* restore(
              loadRuntimeProfileDeclarations(
                effectiveInputs(inputsFor(cwd), fresh.config),
                scan,
                lastGoodFor(place),
              ).pipe(Effect.provideContext(platformServicesContext)),
            )
            // Profiles of one declaration key differ only by the last good
            // versions their builds decided by; the one whose versions are
            // still the last good ones serves.
            const declarationKey = profileKey(place, declarations.extensionDeclarations, files)
            const found = Option.fromNullishOr(
              [...entries.values()].find(
                (entry) => entry.declarationKey === declarationKey && runsCurrentLastGood(entry),
              ),
            )
            if (Option.isSome(found)) {
              aliases.set(list, found.value.key)
              return found.value
            }
            const built = yield* buildProfile(place, cwd, fresh, declarations, restore).pipe(
              Effect.orDie,
            )
            // The build decided by the last good versions as they are now
            // (the place's lock is held). A stored profile with this key
            // decided by the same ones, so it would have been found above:
            // the key is new and no stored entry is lost.
            const consulted = consultedLastGood(place, built.profile.resolved)
            const key = [declarationKey, consultedKey(consulted)].join("\u0001")
            const entry: ProfileEntry = { key, declarationKey, consulted, place, ...built }
            entries.set(key, entry)
            aliases.set(list, key)
            yield* Effect.logInfo("session-profile.initialized").pipe(
              Effect.annotateLogs({
                cwd: entry.profile.cwd,
                extensionCount: entry.profile.resolved.extensions.length,
                sectionCount: entry.profile.baseSections.length,
              }),
            )
            return entry
          })

        /**
         * Drop a superseded profile no lease holds: its scope, and the shared
         * resources no other profile holds. The caller closes the returned
         * scopes after it releases the place's lock, so an extension
         * finalizer never runs under it.
         */
        const retireIfUnused = (key: string): Option.Option<ReadonlyArray<Scope.Closeable>> => {
          const entry = Option.fromNullishOr(entries.get(key))
          if (Option.isNone(entry)) return Option.none()
          if ((leases.get(key) ?? 0) > 0) return Option.none()
          if (current.get(entry.value.place) === key) return Option.none()
          entries.delete(key)
          leases.delete(key)
          for (const [list, target] of aliases) if (target === key) aliases.delete(list)
          return Option.some([entry.value.scope, ...dropResources(entry.value.resources)])
        }

        const closeRetired = (retired: Option.Option<ReadonlyArray<Scope.Closeable>>) =>
          Option.match(retired, {
            onNone: () => Effect.void,
            onSome: (scopes) =>
              closeScopes(scopes).pipe(Effect.andThen(Effect.logInfo("session-profile.retired"))),
          })

        const release = (entry: ProfileEntry, lock: Semaphore.Semaphore) =>
          Effect.sync(() => {
            leases.set(entry.key, (leases.get(entry.key) ?? 1) - 1)
            return retireIfUnused(entry.key)
          }).pipe(lock.withPermits(1), Effect.flatMap(closeRetired))

        const resolve: SessionProfileCacheService["resolve"] = (cwd) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const callerScope = yield* Scope.Scope
            const canonicalCwd = pathSvc.resolve(cwd)
            const place = placeKey(workspaceId, canonicalCwd)
            const lock = yield* lockFor(place)
            // Finding or building the entry, its lease, and `current` are one
            // step no interrupt can split: an entry stored without its lease
            // and not current would never retire. Only the reads and the
            // build inside it (`restore`) can be interrupted. The lease's
            // release joins the caller's scope after the lock is let go: a
            // scope that already closed (a loop that closed while one of its
            // fibers resolved) runs the release at once, and the release
            // takes the lock. Retired scopes close after releasing it, within
            // the same protected transfer, so interruption cannot lose cleanup.
            const entry = yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* restore(lock.take(1))
                const leased = yield* Effect.gen(function* () {
                  // The config is read under the place lock, so resolves set
                  // `current` in the order they read it: a read from before an
                  // edit cannot put the older profile back.
                  const fresh = yield* restore(configService.getFresh(canonicalCwd))
                  const scan = yield* restore(
                    scanRuntimeProfileExtensions(inputsFor(canonicalCwd), graphs).pipe(
                      Effect.provideContext(platformServicesContext),
                    ),
                  )
                  const list = listKey(
                    place,
                    effectiveInputs(inputsFor(canonicalCwd), fresh.config).disabledExtensions ?? [],
                    filesStamp(place, scan),
                  )
                  const entry = yield* entryFor(place, list, scan, canonicalCwd, fresh, restore)
                  recordLastGood(place, entry.profile.resolved)
                  leases.set(entry.key, (leases.get(entry.key) ?? 0) + 1)
                  const previous = Option.fromNullishOr(current.get(place))
                  current.set(place, entry.key)
                  const retired = Option.flatMap(
                    Option.filter(previous, (key) => key !== entry.key),
                    retireIfUnused,
                  )
                  return { entry, retired }
                }).pipe(Effect.ensuring(lock.release(1)))
                yield* Scope.addFinalizer(callerScope, release(leased.entry, lock))
                yield* closeRetired(leased.retired)
                return leased.entry
              }),
            )
            return entry.profile
          })

        const reload: SessionProfileCacheService["reload"] = (cwd, id) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const place = placeKey(workspaceId, pathSvc.resolve(cwd))
            const lock = yield* lockFor(place)
            yield* Effect.sync(() => {
              const counts = reloads.get(place) ?? new Map<string, number>()
              counts.set(id, (counts.get(id) ?? 0) + 1)
              reloads.set(place, counts)
            }).pipe(lock.withPermits(1))
          })

        return SessionProfileCache.of({ resolve, reload })
      }),
    )
}

// ── approval-service ────────────────────────────────────────────────────────

/**
 * The approval service: `makeInteractionService` with the fixed approval
 * schema, one per server scope. Requests and resolutions live in
 * `InteractionStorage`, so a tool that runs again takes its stored answer.
 * Tools reach it through `ctx.Interaction.approve()` on `ExtensionContext`.
 */

const logStoreFailure =
  (write: "resolve" | "take", requestId: InteractionRequestId) => (error: StorageError) =>
    Effect.logWarning(`interaction.${write}-failed`).pipe(
      Effect.annotateLogs({ requestId, error: String(error) }),
    )

const makeApprovalInteractionService: Effect.Effect<
  InteractionService,
  never,
  EventStore | GentPlatform | InteractionStorage
> = Effect.gen(function* () {
  const store = yield* InteractionStorage
  const storage: InteractionStorageConfig = {
    persist: (record) =>
      store.persist(record).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new EventStoreError({ message: "Failed to persist interaction request", cause }),
        ),
      ),
    // A failed resolve or take leaves the row open, so the startup recovery
    // asks it again; the call goes on, and the log names the request.
    resolve: (requestId) =>
      store.resolve(requestId).pipe(Effect.catchEager(logStoreFailure("resolve", requestId))),
    take: (requestId) =>
      store.take(requestId).pipe(Effect.catchEager(logStoreFailure("take", requestId))),
    decide: (branch, requestId, decisionJson) =>
      store
        .decide(branch, requestId, decisionJson)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EventStoreError({ message: "Failed to persist interaction decision", cause }),
          ),
        ),
  }
  const eventStore = yield* EventStore
  return yield* makeInteractionService({
    onPresent: (requestId, params, ctx) =>
      eventStore.publish(
        InteractionPresented.make({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          requestId,
          text: params.text,
          metadata: params.metadata,
        }),
      ),
    // A dialog closed without an answer is dismissed, not declined.
    onDismiss: (requestId, ctx) =>
      eventStore
        .publish(
          InteractionResolved.make({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            requestId,
            approved: false,
            dismissed: true,
          }),
        )
        .pipe(
          Effect.catchEager((error) =>
            Effect.logWarning("interaction.dismiss-publish-failed").pipe(
              Effect.annotateLogs({ error: String(error) }),
            ),
          ),
        ),
    storage,
  })
})

export class ApprovalService extends Context.Service<ApprovalService, InteractionService>()(
  "@gent/core/src/runtime/extension-host/ApprovalService",
) {
  static Live: Layer.Layer<ApprovalService, never, EventStore | GentPlatform | InteractionStorage> =
    Layer.effect(ApprovalService, makeApprovalInteractionService)

  static Test = (decisions?: ReadonlyArray<ApprovalDecision>): Layer.Layer<ApprovalService> => {
    const queue = [...(decisions ?? [{ approved: true }])]
    return Layer.succeed(
      ApprovalService,
      ApprovalService.of({
        present: () => {
          const decision = Option.getOrElse(Option.fromUndefinedOr(queue.shift()), () => ({
            approved: true,
          }))
          return Effect.succeed(decision)
        },
        storeResolution: () => Effect.succeed(false),
        rehydrate: () => Effect.succeed(false),
        answered: () => Effect.succeed(false),
        endTurn: () => Effect.void,
        beginStep: () => Effect.void,
        ownCall: () => (self) => self,
      }),
    )
  }
}

// ── make-extension-host-context ─────────────────────────────────────────────

/**
 * The host context an extension reaches through `ExtensionContext`.
 *
 * Built once per loop from the services in scope. A facet whose service is
 * absent still assembles; it reports the absence only if something calls it,
 * so a root that ships no approval flow provides no stub for one.
 */

interface ExtensionSessionControlService {
  readonly queueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly content: string
    readonly metadata?: MessageMetadata
    readonly wake?: boolean
    readonly clientRequest?: ClientRequestGrant
  }) => Effect.Effect<void, Error>
  readonly dequeueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<boolean, Error>
  /** One user message on another branch's loop. */
  readonly send: (input: SendUserMessagePayload) => Effect.Effect<void, Error>
  /** Steer a branch; `clientRequest` is the grant of the client request it runs under. */
  readonly steer: (
    command: SteerCommand,
    clientRequest?: ClientRequestGrant,
  ) => Effect.Effect<void, Error>
  /** Stop what one message opens on a branch; true when the stop reached it. */
  readonly stopMessage: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly messageId: MessageId
    readonly requestId: RequestId
    /** The branch that asks: a take-back names what its own earlier stop already reported. */
    readonly requester: RequesterBranch
  }) => Effect.Effect<boolean, Error>
  /** Holds the loop's own entity resident until the enclosing scope closes. */
  readonly holdResident: Effect.Effect<void, never, ScopeType.Scope>
}

/** Decoding entity ids is cheap; bound it so a large registry does not stall a listing. */
const ACTIVE_LOOP_DECODE_CONCURRENCY = 8

/** When the loop's current turn began; an idle loop runs no turn. */
const turnStartOf = (state: SessionRuntimeState): Option.Option<number> => {
  if (state._tag === "Idle") return Option.none()
  return Option.some(state.startedAtMs)
}

interface ExtensionHostContextInput {
  /** Built by the caller over `GentPlatform`, which is an Effect rather than a service Tag. */
  readonly host: ExtensionHostPlatform
  /**
   * The classifier facet, built by the caller over `DecisionModelResolver`
   * (`makeExtensionModels`), which this module cannot import.
   */
  readonly models: ExtensionModelsService
  /** The loop's follow-up queue. Absent outside a loop. */
  readonly sessionControl?: ExtensionSessionControlService
}

/**
 * What opened a run. A turn knows whether a client sent its opening message.
 * A client's extension request (a slash command, say) is client-opened, and
 * while it runs a message it sends to its own branch keeps the client origin
 * through the grant its branch's loop holds live until the request ends
 * (`clientRequestGrant`).
 */
export const RunOpener = Schema.TaggedUnion({
  Turn: { openedByClient: Schema.Boolean },
  ClientRequest: { grant: ClientRequestGrant },
})
export type RunOpener = typeof RunOpener.Type

const clientRequestOf = (opener: RunOpener): Option.Option<ClientRequestGrant> => {
  if (opener._tag === "ClientRequest") return Option.some(opener.grant)
  return Option.none()
}

const runOpenedByClient = (opener: RunOpener): boolean => {
  if (opener._tag === "ClientRequest") return true
  return opener.openedByClient
}

interface MakeExtensionHostContextRunInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** Session-scoped cwd. Falls back to RuntimeEnvironment.cwd when absent. */
  readonly sessionCwd?: string
  /**
   * False: no user watches this turn (`turnCanAsk`), so no one can answer
   * an approval in it.
   */
  readonly interactive: boolean
  /** The live grant, when a client's extension request opened this run. */
  readonly clientRequest: Option.Option<ClientRequestGrant>
}

/** Builds the `ExtensionHostContext` for one run of one branch. */
interface ExtensionHostContextProvider {
  readonly forRun: (runInfo: MakeExtensionHostContextRunInfo) => ExtensionHostContext
}

/** Runs `use` against the service, or dies naming the absent one. */
type Facet<S> = <A, E, R>(use: (service: S) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

const via =
  <S>(service: Option.Option<S>, name: string): Facet<S> =>
  (use) =>
    Option.match(service, {
      onNone: () => Effect.die(`${name} not available`),
      onSome: use,
    })

const facet = <I, S>(tag: Context.Key<I, S>, name: string): Effect.Effect<Facet<S>> =>
  Effect.serviceOption(tag).pipe(Effect.map((service) => via(service, name)))

const sessionError = (operation: string) => extensionServiceError("ExtensionSession", operation)

/**
 * The answer to an approval asked in a turn no user started. It says how the
 * request reaches someone, and that no message can grant it, so a child
 * told "go ahead" does not ask again.
 */
const unanswerableApproval: ApprovalDecision = {
  approved: false,
  notes:
    "Declined: no user started this turn, so no one can approve it here, and asking again in this turn is declined again. Report what you asked for and why you need it the way this turn reports its result, then end your turn. No message can grant it: whoever reads your report acts on it, or a user prompts this session directly and approves it there.",
}

/** A pending interaction is the caller's to handle; anything else is a service failure. */
const mapInteraction = <A, E>(
  operation: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, ExtensionServiceError | InteractionPendingError> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (Schema.is(InteractionPendingError)(cause)) return cause
      return extensionServiceError("ExtensionInteraction", operation)(cause)
    }),
  )

export const makeExtensionHostContextProvider = (
  input: ExtensionHostContextInput,
): Effect.Effect<ExtensionHostContextProvider, never, RuntimeEnvironment> =>
  Effect.gen(function* () {
    const environment = yield* RuntimeEnvironment
    const host = input.host
    const control = via(Option.fromUndefinedOr(input.sessionControl), "SessionControl")
    const approval = yield* facet(ApprovalService, "ApprovalService")
    const sql = yield* facet(SqlClient.SqlClient, "SqlClient")
    const sessions = yield* facet(SessionStorage, "SessionStorage")
    const branches = yield* facet(BranchStorage, "BranchStorage")
    const messages = yield* facet(MessageStorage, "MessageStorage")
    const relationships = yield* facet(RelationshipStorage, "RelationshipStorage")
    const mutations = yield* facet(SessionMutations, "SessionMutations")
    const eventStore = yield* facet(EventStore, "EventStore")
    // Enumerating a workspace's loops needs only the actor state registry,
    // which exists only where an actor layer is in scope.
    const registry = yield* facet(ActorStateRegistry, "ActorStateRegistry")

    // A session call made later from a background fiber, after the turn that
    // built this context, must still land in the workspace the loop opened
    // under. The actor decodes that workspace from its entity id and provides
    // it around this construction, so pinning it here anchors every later call
    // to the loop rather than to whichever fiber happens to make it.
    const workspaceId = yield* CurrentWorkspaceId
    const inWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      effect.pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))

    // Every addressed verb validates its durable target first, as the RPC
    // path does: an actor opened for a branch that does not exist would fail
    // late on a foreign key and linger.
    const requireTarget = (
      operation: string,
      target: { readonly sessionId: SessionId; readonly branchId: BranchId },
    ) =>
      sessions((sessionStorage) =>
        branches((branchStorage) =>
          resolveExistingSessionBranch(target).pipe(
            Effect.provideService(SessionStorage, sessionStorage),
            Effect.provideService(BranchStorage, branchStorage),
          ),
        ),
      ).pipe(Effect.mapError(sessionError(operation)), Effect.asVoid)

    const fileLock = yield* facet(FileLockService, "FileLockService")
    const FileLock: ExtensionFileLockServiceApi = {
      withLock: (path, effect) => fileLock((service) => service.withLock(path, effect)),
    }

    // The `Extensions` facet reads the profile the session's turns resolve,
    // and the config files, the way `extension.listStatus` does.
    const profiles = yield* facet(SessionProfileCache, "SessionProfileCache")
    const configs = yield* facet(ConfigService, "ConfigService")
    const paths = yield* facet(Path.Path, "Path")
    const extensionStatuses = (cwd: string) =>
      profiles((cache) =>
        configs((configService) =>
          paths((path) =>
            Effect.gen(function* () {
              const profile = yield* cache.resolve(cwd)
              const configStatuses = yield* configHealthStatuses(cwd).pipe(
                Effect.provideService(ConfigService, configService),
                Effect.provideService(Path.Path, path),
                Effect.provideService(RuntimeEnvironment, environment),
              )
              return [...profile.resolved.extensionStatuses, ...configStatuses].map(
                extensionStatusOf,
              )
            }).pipe(Effect.scoped),
          ),
        ),
      ).pipe(inWorkspace)
    const extensionsFacet = (cwd: string): ExtensionExtensionsService => ({
      status: extensionStatuses(cwd),
      reload: (id) =>
        Effect.gen(function* () {
          const before = yield* extensionStatuses(cwd)
          if (!before.some((status) => status.id === id)) {
            return yield* new ExtensionServiceError({
              service: "ExtensionExtensions",
              operation: "reload",
              message: `No extension "${id}" in the profile of ${cwd}`,
            })
          }
          yield* profiles((cache) => cache.reload(cwd, ExtensionId.make(id))).pipe(inWorkspace)
          return yield* extensionStatuses(cwd)
        }),
    })

    // `Session.events` from the start replays the history; from now it
    // starts at the newest stored event.
    const subscribeFrom = (from: "start" | "now"): EventId | "latest" => {
      if (from === "now") return "latest"
      return EventId.make(0)
    }

    // An unnamed target is the run's own branch.
    const targetIn = (
      runInfo: MakeExtensionHostContextRunInfo,
      params: { readonly sessionId?: SessionId; readonly branchId?: BranchId },
    ) => ({
      sessionId: params.sessionId ?? runInfo.sessionId,
      branchId: params.branchId ?? runInfo.branchId,
    })

    /**
     * The grant a message a run sends carries. The extension boundary already
     * removed any client origin the sender claimed (`extensionMetadata`).
     * A client's extension request sends as its client while it runs, to its
     * own branch only: the user who typed the slash command watches that
     * branch. Only a message to that branch carries the request's grant, and
     * the loop decides the origin when it admits the message: a message
     * admitted after the request ended (from a fiber it left behind) stays an
     * extension send. The rule is the same for every extension, since any
     * request a client calls gets it.
     */
    const clientRequestGrant = (
      runInfo: MakeExtensionHostContextRunInfo,
      target: { readonly sessionId: SessionId; readonly branchId: BranchId },
    ) =>
      Option.getOrUndefined(
        Option.filter(
          runInfo.clientRequest,
          () => target.sessionId === runInfo.sessionId && target.branchId === runInfo.branchId,
        ),
      )

    const forRun = (runInfo: MakeExtensionHostContextRunInfo): ExtensionHostContext => ({
      sessionId: runInfo.sessionId,
      branchId: runInfo.branchId,
      cwd: runInfo.sessionCwd ?? environment.cwd,
      home: environment.home,
      host,
      FileLock,
      Models: input.models,
      Extensions: extensionsFacet(runInfo.sessionCwd ?? environment.cwd),

      State: ((extensionId) =>
        Option.match(extensionId, {
          onNone: () => ({
            changed: () =>
              Effect.fail(
                new ExtensionServiceError({
                  service: "ExtensionState",
                  operation: "changed",
                  message: "Extension id unavailable for state change notification",
                }),
              ),
          }),
          onSome: (id) => ({
            changed: () =>
              eventStore((store) =>
                mapExtensionServiceError(
                  "ExtensionState",
                  "changed",
                  inWorkspace(
                    store.publish(
                      ExtensionStateChanged.make({
                        extensionId: id,
                        sessionId: runInfo.sessionId,
                        branchId: runInfo.branchId,
                      }),
                    ),
                  ),
                ),
              ),
          }),
        })) satisfies ExtensionStateFacet,

      Session: {
        getSession: (sessionId) =>
          sessions((storage) => storage.getSession(sessionId ?? runInfo.sessionId)).pipe(
            Effect.mapError(sessionError("getSession")),
            inWorkspace,
          ),
        getDetail: (sessionId) =>
          relationships((storage) => storage.getSessionDetail(sessionId)).pipe(
            Effect.mapError(sessionError("getDetail")),
            inWorkspace,
          ),
        renameCurrent: (name, options) =>
          mutations((service) =>
            service.renameSession({ sessionId: runInfo.sessionId, name, ...options }),
          ).pipe(Effect.mapError(sessionError("renameCurrent")), inWorkspace),
        create: (params) =>
          mutations((service) =>
            service.createSession({
              name: params.name,
              cwd: params.cwd ?? runInfo.sessionCwd ?? environment.cwd,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              historyBranchId: params.historyBranchId,
              admission: params.admission,
              modelId: params.modelId,
              reasoningLevel: params.reasoningLevel,
              requestId: params.requestId,
            }),
          ).pipe(
            Effect.map(({ sessionId, branchId }) => ({ sessionId, branchId })),
            Effect.mapError(sessionError("create")),
            inWorkspace,
          ),
        delete: (sessionId) =>
          mutations((service) => service.deleteSession(sessionId)).pipe(
            Effect.mapError(sessionError("delete")),
            inWorkspace,
          ),
        send: (params) =>
          decodeSessionSend(params, { onExcessProperty: "error" }).pipe(
            Effect.mapError(
              (error) =>
                new ExtensionServiceError({
                  service: "ExtensionSession",
                  operation: "send",
                  message: error.message,
                }),
            ),
            Effect.flatMap((decoded) =>
              SessionSendParams.match(decoded, {
                turn: (turn) =>
                  Effect.gen(function* () {
                    if (
                      turn.sessionId === runInfo.sessionId &&
                      turn.branchId === runInfo.branchId
                    ) {
                      return yield* new ExtensionServiceError({
                        service: "ExtensionSession",
                        operation: "send",
                        message:
                          'a "turn" targets another branch; send this one a "queue" delivery',
                      })
                    }
                    yield* requireTarget("send", turn)
                    yield* control((loop) =>
                      loop.send({
                        sessionId: turn.sessionId,
                        branchId: turn.branchId,
                        content: turn.content,
                        commandId: turn.commandId,
                        completion: turn.completion,
                        metadata: turn.metadata,
                      }),
                    ).pipe(Effect.mapError(sessionError("send")))
                  }),
                queue: (queued) =>
                  Effect.gen(function* () {
                    const target = targetIn(runInfo, queued)
                    yield* requireTarget("send", target)
                    yield* control((loop) =>
                      loop.queueFollowUp({
                        ...target,
                        sourceId: queued.sourceId,
                        content: queued.content,
                        metadata: queued.metadata,
                        wake: queued.wake,
                        ...omitUndefined({ clientRequest: clientRequestGrant(runInfo, target) }),
                      }),
                    ).pipe(Effect.mapError(sessionError("send")))
                  }),
                steer: (steered) =>
                  Effect.gen(function* () {
                    const target = targetIn(runInfo, steered)
                    yield* requireTarget("send", target)
                    const requestId = steered.requestId ?? RequestId.make(yield* host.randomId)
                    yield* control((loop) =>
                      loop.steer(
                        {
                          _tag: "Interject",
                          ...target,
                          requestId,
                          message: steered.content,
                          metadata: steered.metadata,
                          wake: steered.wake,
                        },
                        clientRequestGrant(runInfo, target),
                      ),
                    ).pipe(Effect.mapError(sessionError("send")))
                  }),
              }),
            ),
            inWorkspace,
          ),
        stop: (params) =>
          Effect.gen(function* () {
            const target = targetIn(runInfo, params)
            yield* requireTarget("stop", target)
            const requestId = params.requestId ?? RequestId.make(yield* host.randomId)
            yield* control((loop) => loop.steer({ _tag: "Cancel", ...target, requestId })).pipe(
              Effect.mapError(sessionError("stop")),
            )
          }).pipe(inWorkspace),
        stopMessage: (params) =>
          Effect.gen(function* () {
            const target = targetIn(runInfo, params)
            yield* requireTarget("stopMessage", target)
            const requestId = params.requestId ?? RequestId.make(yield* host.randomId)
            return yield* control((loop) =>
              loop.stopMessage({
                ...target,
                messageId: params.messageId,
                requestId,
                requester: { sessionId: runInfo.sessionId, branchId: runInfo.branchId },
              }),
            ).pipe(Effect.mapError(sessionError("stopMessage")))
          }).pipe(inWorkspace),
        // The subscription does its reads at pull time, so the workspace is
        // pinned on the stream, not on the effect that builds it.
        events: ({ from, ...target }) =>
          Stream.unwrap(
            eventStore((store) =>
              Effect.succeed(
                store
                  .subscribe({
                    ...target,
                    after: subscribeFrom(from ?? "start"),
                    synchronize: true,
                  })
                  .pipe(
                    Stream.map((envelope) => envelope.event),
                    Stream.mapError(sessionError("events")),
                  ),
              ),
            ),
          ).pipe(Stream.provideService(CurrentWorkspaceId, workspaceId)),
        dequeueFollowUp: (params) => {
          const target = targetIn(runInfo, params)
          return requireTarget("dequeueFollowUp", target).pipe(
            Effect.andThen(
              control((loop) =>
                loop.dequeueFollowUp({ ...target, sourceId: params.sourceId }),
              ).pipe(Effect.mapError(sessionError("dequeueFollowUp"))),
            ),
            inWorkspace,
          )
        },
        // A run outside a loop has no entity to hold.
        holdResident: Option.match(Option.fromUndefinedOr(input.sessionControl), {
          onNone: () => Effect.void,
          onSome: (loop) => loop.holdResident,
        }),
        listBranches: branches((storage) => storage.listBranches(runInfo.sessionId)).pipe(
          Effect.mapError(sessionError("listBranches")),
          inWorkspace,
        ),
        listSessions: (params) =>
          Option.match(Option.fromUndefinedOr(params?.root), {
            onNone: () => sessions((storage) => storage.listSessions),
            onSome: (root) => relationships((storage) => storage.getSessionTree(root)),
          }).pipe(Effect.mapError(sessionError("listSessions")), inWorkspace),
        listActiveLoops: registry((stateRegistry) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const entityIds = yield* listStateEntityIds(AgentLoopActor.name).pipe(
              Effect.provideService(ActorStateRegistry, stateRegistry),
            )
            const loops = yield* listWorkspaceLoops({
              workspaceId,
              entityIds,
              concurrency: ACTIVE_LOOP_DECODE_CONCURRENCY,
            })
            // The loop registers its runtime state with the registry, so the
            // status is a memory read: no actor message, no mutation permit.
            return yield* Effect.forEach(
              loops,
              (loop) =>
                stateOf<SessionRuntimeState>({
                  entityType: AgentLoopActor.name,
                  entityId: entityIdOf(workspaceId, loop.sessionId, loop.branchId),
                }).pipe(
                  Effect.asSome,
                  Effect.catchEager(() => Effect.succeed(Option.none<SessionRuntimeState>())),
                  Effect.provideService(ActorStateRegistry, stateRegistry),
                  Effect.map((state) => ({
                    ...loop,
                    status: Option.map(state, (read) => read._tag),
                    runningSince: Option.flatMap(state, turnStartOf),
                  })),
                ),
              { concurrency: ACTIVE_LOOP_DECODE_CONCURRENCY },
            )
          }),
        ).pipe(Effect.mapError(sessionError("listActiveLoops")), inWorkspace),
      },

      Interaction: {
        // An approval no one is shown would park the turn for good, so a
        // turn no user started declines at once and says who can answer.
        approve: (params) => {
          if (runInfo.interactive === false) return Effect.succeed(unanswerableApproval)
          return mapInteraction(
            "approve",
            approval((service) =>
              service.present(params, { sessionId: runInfo.sessionId, branchId: runInfo.branchId }),
            ),
          )
        },
        // A presented note is a hidden assistant message: stored, then delivered.
        present: (params) =>
          mapInteraction(
            "present",
            Effect.gen(function* () {
              const text = Option.match(Option.fromUndefinedOr(params.title), {
                onNone: () => params.content,
                onSome: (title) => `# ${title}\n\n${params.content}`,
              })
              const message = Message.cases.regular.make({
                id: MessageId.make(yield* host.randomId),
                sessionId: runInfo.sessionId,
                branchId: runInfo.branchId,
                role: "assistant",
                parts: [Prompt.textPart({ text })],
                createdAt: yield* DateTime.nowAsDate,
                metadata: { customType: "prompt-present", hidden: true },
              })
              const envelope = yield* sql((client) =>
                messages((store) => store.createMessage(message)).pipe(
                  Effect.andThen(
                    eventStore((events) => events.append(MessageReceived.make({ message }))),
                  ),
                  client.withTransaction,
                ),
              )
              yield* eventStore((events) => events.deliver(envelope))
            }),
          ),
      },
    })

    return { forRun }
  })

// ── session-runtime-context ─────────────────────────────────────────────────

interface ExistingSessionBranch {
  readonly session: Session
  readonly branch: Branch
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

/**
 * The stored session; none when its row is missing (a deleted session). A
 * storage failure fails: the launch profile and the host cwd would be
 * another project's.
 */
const storedSession = (
  sessionId: SessionId,
): Effect.Effect<Option.Option<Session>, StorageError, SessionStorage> =>
  Effect.flatMap(SessionStorage, (sessions) =>
    Effect.map(sessions.getSession(sessionId), Option.fromUndefinedOr),
  )

/**
 * The session's working directory: its stored cwd, else the host's. The same
 * rule gives `ExtensionContext.cwd`, so branch work runs where its tools do.
 */
export const sessionWorkingDirectory = (
  sessionId: SessionId,
): Effect.Effect<string, StorageError, SessionStorage | RuntimeEnvironment> =>
  Effect.gen(function* () {
    const environment = yield* RuntimeEnvironment
    const stored = yield* storedSession(sessionId)
    return Option.getOrElse(
      Option.flatMap(stored, (session) => Option.fromUndefinedOr(session.cwd)),
      () => environment.cwd,
    )
  })

/**
 * Resolve the turn profile for one branch. The profile of the session's
 * working directory (the stored cwd, else the host's) is the one owner of the
 * turn's extension services. A failed session read fails the resolve. The
 * caller's scope holds the profile's lease for as long as it uses it.
 */
export const resolveTurnProfile = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly profileCache: Pick<SessionProfileCacheService, "resolve">
  readonly hostProvider: ExtensionHostContextProvider
  readonly opener: RunOpener
}): Effect.Effect<
  AgentLoopTurnProfile,
  StorageError,
  SessionStorage | RuntimeEnvironment | ScopeType.Scope
> =>
  Effect.gen(function* () {
    const environment = yield* RuntimeEnvironment
    const hostProvider = params.hostProvider
    const session = yield* storedSession(params.sessionId)
    const sessionCwd = Option.flatMap(session, (value) => Option.fromUndefinedOr(value.cwd))
    const interactive = turnCanAsk({
      sessionIsSpawned: Option.exists(session, isSpawnedSession),
      openedByClient: runOpenedByClient(params.opener),
    })
    const runInfo = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      sessionCwd: Option.getOrUndefined(sessionCwd),
      interactive,
      clientRequest: clientRequestOf(params.opener),
    }
    const profile = yield* params.profileCache.resolve(
      Option.getOrElse(sessionCwd, () => environment.cwd),
    )
    return {
      turnBaseSections: profile.baseSections,
      turnHostCtx: hostProvider.forRun(runInfo),
      turnInteractive: interactive,
      turnCapabilityContext: profile.layerContext,
      turnGenerationId: profile.generationId,
    }
  })

export const resolveExistingSessionBranch = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}): Effect.Effect<ExistingSessionBranch, StorageError, SessionStorage | BranchStorage> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const session = yield* sessionStorage.getSession(params.sessionId)
    if (Predicate.isUndefined(session)) {
      return yield* new StorageError({
        message: `Session not found: ${params.sessionId}`,
      })
    }

    const branch = yield* branchStorage.getBranch(params.branchId)
    if (Predicate.isUndefined(branch) || branch.sessionId !== params.sessionId) {
      return yield* new StorageError({
        message: `Branch not found for session: ${params.sessionId}/${params.branchId}`,
      })
    }

    return {
      session,
      branch,
      sessionId: session.id,
      branchId: branch.id,
    }
  })
