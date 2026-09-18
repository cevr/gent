import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
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
  type ExtensionFilesService,
  type ExtensionHook,
  ExtensionHost,
  type ExtensionHostContext,
  type ExtensionHostPlatform,
  ExtensionHostProcessError,
  ExtensionLoadError,
  type ExtensionLoaderServices,
  type ExtensionProcessService,
  type ExtensionScope,
  extensionServiceError,
  ExtensionServiceError,
  type ExtensionSetupServices,
  type ExtensionStateFacet,
  type ExtensionStatusInfo,
  type ExtensionTurnContext,
  type FailedExtension,
  type FailedExtensionPhase,
  FileLockService,
  type GentExtension,
  isClientFile,
  type LoadedExtension,
  makeCollectingExtensionHost,
  makeFileWriter,
  mapExtensionServiceError,
  provideExtensionServices,
  type ResourceScope,
  sealRuntimeLoadedEffect,
  SessionMutations,
  sortExtensionsByScope,
  type SystemPromptInput,
  type ToolPolicyFragment,
  type TurnAfterInput,
  validateExtensionPackage,
} from "../domain/extension.js"
import {
  type BranchId,
  ExtensionId,
  type InteractionRequestId,
  MessageId,
  ProcessGenerationId,
  type RpcId,
  type SessionId,
  type ToolCallId,
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
import { type AgentDefinition, AgentRunnerService, Model } from "../domain/agent.js"
import { causeMessage, omitUndefined } from "../domain/guards.js"
import {
  DriverError,
  DriverFailureId,
  type ExternalDriverContribution,
  type ModelDriverContribution,
  type ProviderAuthError,
  type ProviderAuthInfo,
} from "../domain/driver.js"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { GentPlatform, runProcess } from "./gent-platform.js"
import {
  ConfigService,
  GENT_CONFIG_DIRECTORY,
  isProjectExtensionDirectoryTrusted,
  RuntimeEnvironment,
  type RuntimeEnvironmentApi,
  type UserConfig,
} from "./config.js"
import { CurrentWorkspaceId, type WorkspaceId } from "../server/workspace-rpc.js"
import {
  EventPublisher,
  EventStore,
  EventStoreError,
  ExtensionStatePublisher,
  InteractionPresented,
  MessageReceived,
} from "../domain/event.js"
import {
  type ApprovalDecision,
  CurrentInteractionOwner,
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
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { ActorStateRegistry, listStateEntityIds, stateOf } from "effect-encore"
import { type Branch, Message, type MessageMetadata, type Session } from "../domain/message.js"
import {
  AgentLoop as AgentLoopActor,
  entityIdOf,
  listWorkspaceLoops,
  type SendUserMessagePayload,
  type SessionRuntimeState,
  type SteerCommandType,
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

type ErasedValue = Schema.Schema.Type<typeof Schema.Unknown>

interface ErasedEffectHandlers<A, E> {
  // This alias marks the intentional unknown channel at the single host
  // membrane. The extension effect is parsed or handled after this point.
  readonly onFailure: (error: ErasedValue) => Effect.Effect<A, E>
  readonly onDefect: (defect: ErasedValue) => Effect.Effect<A, E>
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
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const sealed = Effect.suspend(effect).pipe(
    Effect.catchEager(handlers.onFailure),
    Effect.catchDefect(handlers.onDefect),
  )
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  return sealed as Effect.Effect<A, E> // oxlint-disable-line effect/noAs, typescript/no-unsafe-type-assertion -- The membrane re-seals the extension effect after erasing its runtime channels. // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
}

/**
 * Variant for hosts that need the raw `Exit` to apply local failure policy
 * (`continue` / `isolate` / `halt`, lifecycle finalizer behavior, etc.).
 */
export const exitErasedEffect = <A>(
  effect: () => Effect.Effect<A, unknown, unknown>,
): Effect.Effect<Exit.Exit<A, unknown>> => {
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  const exit = Effect.exit(Effect.suspend(effect))
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  return exit as Effect.Effect<Exit.Exit<A, unknown>> // oxlint-disable-line effect/noAs, typescript/no-unsafe-type-assertion -- The membrane exposes the raw exit after erasing the extension effect channels. // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect membrane owns erased runtime context boundary
export type ErasedResourceLayer = Layer.Layer<any, never, never>

/**
 * Resource-host call sites keep the old narrower return type (`Layer.Layer<any>`)
 * so resource layers do not leak their heterogeneous error or requirement
 * channels into tests.
 */
export const eraseResourceLayer = <A, E, R>(layer: Layer.Layer<A, E, R>): ErasedResourceLayer => {
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions, typescript/no-unsafe-type-assertion -- The resource membrane intentionally erases heterogeneous service output and requirements.
  const erased = layer as unknown as ErasedResourceLayer // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- Effect membrane owns erased runtime context boundary
  return erased
}

// oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- The empty layer is the erased identity for heterogeneous resource composition.
export const emptyErasedResourceLayer: ErasedResourceLayer = Layer.empty as ErasedResourceLayer

/** Per-leaf facts layered over the current run's host context. */
interface ExtensionLeafFrame {
  readonly extensionId?: ExtensionId
  readonly toolCallId?: ToolCallId
  readonly turn?: ExtensionTurnContext
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
    turn: ExtensionTurnContext,
  ) => Effect.Effect<ExtensionTurnProjection, never, CurrentExtensionHostContext>
  readonly emitTurnAfter: (
    input: TurnAfterInput,
  ) => Effect.Effect<void, never, CurrentExtensionHostContext>
}

interface ExtensionTurnProjection {
  readonly promptSections: ReadonlyArray<PromptSection>
  readonly policyFragments: ReadonlyArray<ToolPolicyFragment>
}

interface RegisteredSystemPromptRewrite {
  readonly extensionId: ExtensionId
  readonly handler: ExtensionHook<SystemPromptInput, string, unknown, unknown>["handler"]
}

interface HookTurnProjectionSlot {
  readonly extensionId: ExtensionId
  readonly handler: () => Effect.Effect<
    {
      readonly promptSections?: ReadonlyArray<PromptSection>
      readonly toolPolicy?: ToolPolicyFragment
    },
    unknown,
    unknown
  >
}

interface RegisteredHook<Input> {
  readonly extensionId: ExtensionId
  readonly handler: (input: Input) => Effect.Effect<void, unknown, unknown>
}

const runHook = <Input>(input: Input, registered: RegisteredHook<Input>) =>
  Effect.gen(function* () {
    const exit = yield* exitErasedEffect(() =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
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
) => {
  if (Option.isNone(projection)) return
  for (const section of projection.value.promptSections) sectionsById.set(section.id, section)
  for (const fragment of projection.value.policyFragments) policyFragments.push(fragment)
}

const runTurnProjectionHook = (slot: HookTurnProjectionSlot, turn: ExtensionTurnContext) =>
  sealErasedEffect<Option.Option<ExtensionTurnProjection>, never>(
    () =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      slot
        .handler()
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
            return Option.some({ promptSections, policyFragments })
          }),
        )
        .pipe(provideExtensionLeaf({ extensionId: slot.extensionId, turn })),
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
  },
) => {
  switch (slot.kind) {
    case "systemPrompt":
      slots.systemPrompt.push({ extensionId: ext.manifest.id, handler: slot.hook.handler })
      return
    case "turnProjection":
      slots.turnProjection.push({
        extensionId: ext.manifest.id,
        handler: () => eraseHookEffect(slot.hook.handler()),
      })
      return
    case "turnAfter":
      slots.turnAfter.push({
        extensionId: ext.manifest.id,
        handler: slot.hook.handler,
      })
      return
  }
}

export const compileExtensionHooks = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledExtensionHooks => {
  const sorted = sortExtensionsByScope(extensions)
  const systemPromptSlots: RegisteredSystemPromptRewrite[] = []
  const turnProjectionSlots: HookTurnProjectionSlot[] = []
  const turnAfterSlots: RegisteredHook<TurnAfterInput>[] = []
  const hookSlots = {
    systemPrompt: systemPromptSlots,
    turnProjection: turnProjectionSlots,
    turnAfter: turnAfterSlots,
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
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
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

    resolveTurnProjection: (turn) =>
      Effect.gen(function* () {
        const sectionsById = new Map<string, PromptSection>()
        const policyFragments: ToolPolicyFragment[] = []

        for (const slot of turnProjectionSlots) {
          collectTurnProjection(
            yield* runTurnProjectionHook(slot, turn),
            sectionsById,
            policyFragments,
          )
        }

        return { promptSections: [...sectionsById.values()], policyFragments }
      }),

    emitTurnAfter: (input) =>
      Effect.gen(function* () {
        for (const slot of turnAfterSlots) yield* runHook(input, slot)
      }),
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
  readonly modelCapabilities: ReadonlyMap<string, ToolCapability>
  readonly rpcRegistry: CompiledRpcRegistry
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
  readonly promptSections: ReadonlyMap<string, PromptSection>
  readonly slashCommands: ReadonlyArray<SlashCommand>
  readonly extensionHooks: CompiledExtensionHooks
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions: ReadonlyArray<FailedExtension>
  readonly extensionStatuses: ReadonlyArray<ExtensionStatusInfo>
}

interface RegisteredToolEntry {
  readonly kind: "tool"
  readonly extensionId: ExtensionId
  readonly capability: ToolCapability
}

interface RegisteredRpcEntry {
  readonly kind: "rpc"
  readonly extensionId: ExtensionId
  readonly capability: RequestCapability
}

type RegisteredCapabilityEntry = RegisteredToolEntry | RegisteredRpcEntry

interface CompiledRpcRegistry {
  /** Whether the request declared itself read-only; false for an unknown request. */
  readonly isReadonly: (extensionId: ExtensionId, capabilityId: RpcId | string) => boolean
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

const compileCapabilityWinners = (
  sorted: ReadonlyArray<LoadedExtension>,
): ReadonlyMap<string, RegisteredCapabilityEntry> => {
  const winners = new Map<string, RegisteredCapabilityEntry>()
  for (const ext of sorted) {
    // Sorted scope-ascending; later writes win. Iterate every typed bucket
    // for each extension so a later-scope contribution from any bucket
    // shadows an earlier registration with the same id.
    for (const cap of Option.getOrElse(Option.fromUndefinedOr(ext.contributions.tools), () => [])) {
      winners.set(String(getToolId(cap)), {
        kind: "tool",
        extensionId: ext.manifest.id,
        capability: cap,
      })
    }
    for (const cap of Option.getOrElse(
      Option.fromUndefinedOr(ext.contributions.requests),
      () => [],
    )) {
      winners.set(String(cap.id), { kind: "rpc", extensionId: ext.manifest.id, capability: cap })
    }
  }
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

const compileCapabilityEntries = (
  sorted: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredCapabilityEntry> => {
  const entries: RegisteredCapabilityEntry[] = []
  for (const ext of sorted) {
    for (const capability of Option.getOrElse(
      Option.fromUndefinedOr(ext.contributions.tools),
      () => [],
    )) {
      entries.push({ kind: "tool", extensionId: ext.manifest.id, capability })
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
    let candidateId: string
    if (candidate.kind === "tool") candidateId = getToolId(candidate.capability)
    else candidateId = candidate.capability.id
    if (candidate.extensionId === extensionId && candidateId === capabilityId)
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
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
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
  isReadonly: (extensionId, capabilityId) =>
    Option.match(resolveCapabilityEntry(entries, extensionId, capabilityId), {
      onNone: () => false,
      onSome: (entry) => entry.kind === "rpc" && entry.capability.readonly === true,
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
  status: "active",
})

const failedExtensionStatus = (failure: FailedExtension): ExtensionStatusInfo => ({
  ...failure,
  status: "failed",
})

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
): ResolvedExtensions => {
  const mergedFailures = [...failedExtensions]
  const sorted = sortExtensionsByScope(extensions)

  // Tool resolution — identity-first scope shadowing followed by bucket
  // authorization. Every leaf (regardless of bucket) enters the candidate map;
  // authorization (`kind === "tool"`) happens AFTER selection so a higher-scope
  // command/rpc override correctly hides a shadowed builtin tool.
  const capabilityWinners = compileCapabilityWinners(sorted)
  const capabilityEntries = compileCapabilityEntries(sorted)
  const rpcRegistry = compileRpcRegistry(capabilityEntries)
  const modelCapabilities = new Map<string, ToolCapability>()
  for (const [id, entry] of capabilityWinners) {
    if (entry.kind !== "tool") continue
    modelCapabilities.set(id, entry.capability)
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
  const externalDrivers = compileBucket(
    sorted,
    (e) => Option.getOrElse(Option.fromUndefinedOr(e.contributions.externalDrivers), () => []),
    (d) => d.id,
  )

  // Prompt sections from capability leaves are read off the WINNERS map,
  // not raw extractions. Otherwise a higher-scope capability shadowing a
  // lower-scope tool would still inherit the loser's prompt — defeating the
  // shadow. Last scope wins by section id.
  // (Dynamic prompt content is assembled per-turn by ExtensionHooks, not here.)
  const promptSectionsMap = new Map<string, PromptSection>()
  for (const { capability: cap } of capabilityWinners.values()) {
    let prompt = Option.none<PromptSection>()
    if (isToolCapability(cap)) prompt = Option.fromUndefinedOr(getToolMetadata(cap).prompt)
    else prompt = Option.fromUndefinedOr(cap.prompt)
    if (Option.isSome(prompt)) promptSectionsMap.set(prompt.value.id, prompt.value)
  }

  const slashCommands = compileSlashCommands(capabilityWinners)

  const extensionHooks = compileExtensionHooks(sorted)
  const extensionStatuses: ExtensionStatusInfo[] = [
    ...sorted.map(activeExtensionStatus),
    ...mergedFailures.map(failedExtensionStatus),
  ]

  return {
    modelCapabilities,
    rpcRegistry,
    agents,
    modelDrivers,
    externalDrivers,
    promptSections: promptSectionsMap,
    slashCommands,
    extensionHooks,
    extensions: sorted,
    failedExtensions: mergedFailures,
    extensionStatuses,
  }
}

// Extension Registry Service

export interface ExtensionRegistryService {
  readonly extensionHooks: CompiledExtensionHooks

  // Raw resolved data — needed for rebuilding extension services in child runtimes
  readonly getResolved: () => ResolvedExtensions
}

export class ExtensionRegistry extends Context.Service<
  ExtensionRegistry,
  ExtensionRegistryService
>()("@gent/core/src/runtime/extension-host/ExtensionRegistry") {
  static fromResolved = (resolved: ResolvedExtensions): Layer.Layer<ExtensionRegistry> =>
    Layer.succeed(
      ExtensionRegistry,
      ExtensionRegistry.of({
        extensionHooks: resolved.extensionHooks,
        getResolved: () => resolved,
      }),
    )

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
}

// ── driver-registry ─────────────────────────────────────────────────────────

/**
 * DriverRegistry — unified lookup over both model and external drivers.
 *
 * Replaces the dual-path dispatch through `ExtensionRegistry.getProvider` +
 * `ExtensionRegistry.getTurnExecutor` with one capability-shaped registry
 * keyed by `DriverRef`. The agent loop reads `agent.driver: DriverRef` and
 * routes through this single seam regardless of whether the underlying
 * implementation is a model provider or an external turn executor —
 * `composability-not-flags`.
 *
 * The contributing extensions still register through their respective
 * contribution kinds (`model-driver` or `external-driver`); this registry
 * is the read side. Auth flow integration (OAuth + API key resolution)
 * stays with model resolution because it belongs to model drivers
 * specifically.
 *
 * @module
 */

const decodeModelCatalog = Schema.decodeUnknownOption(Schema.Array(Model))

// ── Resolved driver state (one map per kind, lookup by id) ──

interface ResolvedDrivers {
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
}

// ── Service interface ──

export interface DriverRegistryService {
  /** Resolve a model driver by id (the `provider` segment of `provider/model`). */
  // oxlint-disable-next-line effect/noNullish -- Driver lookup preserves an absent-driver result at this internal boundary.
  readonly getModel: (id: string) => Effect.Effect<ModelDriverContribution | undefined>
  /** Resolve an external driver by id (the runner id, e.g. `acp-claude-code`). */
  // oxlint-disable-next-line effect/noNullish -- Driver lookup preserves an absent-driver result at this internal boundary.
  readonly getExternal: (id: string) => Effect.Effect<ExternalDriverContribution | undefined>
  /** All registered model drivers in registration order. */
  readonly listModels: Effect.Effect<ReadonlyArray<ModelDriverContribution>>
  /** All registered external drivers in registration order. */
  readonly listExternal: Effect.Effect<ReadonlyArray<ExternalDriverContribution>>
  /** Concatenate every model driver's own catalog. Core fetches nothing itself. */
  readonly listModelCatalog: (
    resolveAuth?: (
      driverId: string,
      // oxlint-disable-next-line effect/noNullish -- Driver auth callbacks may have no auth result.
    ) => Effect.Effect<ProviderAuthInfo | undefined, ProviderAuthError>,
  ) => Effect.Effect<ReadonlyArray<Model>, DriverError | ProviderAuthError>
}

export class DriverRegistry extends Context.Service<DriverRegistry, DriverRegistryService>()(
  "@gent/core/src/runtime/extension-host/DriverRegistry",
) {
  static fromResolved = (resolved: ResolvedDrivers): Layer.Layer<DriverRegistry> =>
    Layer.succeed(
      DriverRegistry,
      DriverRegistry.of({
        getModel: (id) => Effect.succeed(resolved.modelDrivers.get(id)),
        getExternal: (id) => Effect.succeed(resolved.externalDrivers.get(id)),
        listModels: Effect.succeed([...resolved.modelDrivers.values()]),
        listExternal: Effect.succeed([...resolved.externalDrivers.values()]),
        listModelCatalog: Effect.fn("DriverRegistry.listModelCatalog")(function* (
          resolveAuth?: (
            driverId: string,
            // oxlint-disable-next-line effect/noNullish -- Driver auth callbacks may have no auth result.
          ) => Effect.Effect<ProviderAuthInfo | undefined, ProviderAuthError>,
        ) {
          const catalog: Array<Model> = []
          for (const driver of resolved.modelDrivers.values()) {
            if (Predicate.isUndefined(driver.listModels)) continue
            let auth = Option.none<ProviderAuthInfo>()
            if (!Predicate.isUndefined(resolveAuth)) {
              auth = yield* resolveAuth(driver.id).pipe(Effect.map(Option.fromUndefinedOr))
            }
            const driverCatalog = yield* driver.listModels(Option.getOrUndefined(auth))
            const decoded = decodeModelCatalog(driverCatalog)
            if (decoded._tag === "None") {
              return yield* new DriverError({
                driver: DriverFailureId.make(driver.id),
                reason: `Model driver "${driver.id}" returned an invalid model catalog`,
              })
            }
            catalog.push(...decoded.value)
          }
          return catalog
        }),
      }),
    )
}

// ── resource-layer ──────────────────────────────────────────────────────────

/**
 * Resource service/lifecycle assembly.
 *
 * Owns heterogeneous Resource layer erasure and lifecycle finalizer policy.
 * Schedule reconciliation owns its own protocol; this module owns only service
 * layers plus start/stop.
 *
 * @module
 */

interface ResourceEntry {
  readonly extensionId: ExtensionId
  readonly resource: AnyResourceContribution
}

class ResourceStartError extends Schema.TaggedError<ResourceStartError>()("ResourceStartError", {
  extensionId: Schema.String,
  cause: Schema.String,
}) {}

const collectResourceEntries = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope,
): ReadonlyArray<ResourceEntry> =>
  extensions.flatMap((ext) =>
    (ext.contributions.resources ?? [])
      .filter((resource) => resource.scope === scope)
      .map((resource) => ({ extensionId: ext.manifest.id, resource })),
  )

const buildLifecycleLayer = (
  entries: ReadonlyArray<ResourceEntry>,
): Layer.Layer<never, ResourceStartError> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      for (const entry of entries) {
        const start = entry.resource.start
        if (!Predicate.isUndefined(start)) {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.
          const exit = yield* exitErasedEffect(() => start)
          if (Exit.isFailure(exit)) {
            yield* Effect.logError("resource.start.failed").pipe(
              Effect.annotateLogs({
                extensionId: entry.extensionId,
                cause: Cause.pretty(exit.cause),
              }),
            )
            return yield* new ResourceStartError({
              extensionId: entry.extensionId,
              cause: Cause.pretty(exit.cause),
            })
          }
        }
        const stop = entry.resource.stop
        if (!Predicate.isUndefined(stop)) {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.
          yield* Effect.addFinalizer(() => exitErasedEffect(() => stop).pipe(Effect.asVoid))
        }
      }
    }),
  )

export const buildResourceLayer = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope = "process",
): ErasedResourceLayer => {
  const entries = collectResourceEntries(extensions, scope)
  if (entries.length === 0) return emptyErasedResourceLayer

  const serviceLayers = entries.reduce<ErasedResourceLayer>(
    (acc, { resource }) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.
      Layer.merge(acc, eraseResourceLayer(resource.layer)),
    emptyErasedResourceLayer,
  )
  const hasLifecycle = entries.some(
    ({ resource }) =>
      !Predicate.isUndefined(resource.start) || !Predicate.isUndefined(resource.stop),
  )
  if (!hasLifecycle) return serviceLayers

  return eraseResourceLayer(Layer.provideMerge(buildLifecycleLayer(entries), serviceLayers))
}

// ── host-platform ───────────────────────────────────────────────────────────

const hasTimedOut = Schema.is(Schema.Struct({ timedOut: Schema.Literal(true) }))

const toHostProcessError =
  (command: string) =>
  (error: Parameters<typeof causeMessage>[0]): ExtensionHostProcessError => {
    const fields = {
      command,
      message: causeMessage(error),
      cause: error,
    }
    if (hasTimedOut(error)) {
      return new ExtensionHostProcessError({ ...fields, timedOut: true })
    }
    return new ExtensionHostProcessError(fields)
  }

export const makeExtensionHostPlatform: Effect.Effect<
  ExtensionHostPlatform,
  never,
  GentPlatform | ChildProcessSpawner
> = Effect.gen(function* () {
  const platform = yield* GentPlatform
  // Captured once so the facade's runProcess keeps a `never` R channel.
  const spawner = yield* ChildProcessSpawner
  const osInfo = yield* platform.osInfo
  const execPath = yield* platform.execPath
  const homeDirectory = yield* platform.homeDirectory
  const parentEnv = yield* platform.env
  const pathListSeparator = yield* platform.pathListSeparator
  return {
    osInfo,
    execPath,
    homeDirectory,
    parentEnv,
    randomId: platform.randomId,
    pathListSeparator,
    runProcess: (command, args, options) =>
      runProcess(command, args, options).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.mapError(toHostProcessError(command)),
      ),
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

/** Discover extension files from a directory. Returns file paths sorted by name. */
const discoverDir = Effect.fn("ExtensionLoader.discoverDir")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const exists = yield* fs.exists(dir)
  if (!exists) return []

  const entries = yield* fs.readDirectory(dir)
  const paths: string[] = []

  for (const entry of entries) {
    // Skip test directories, hidden files, and TUI extension files
    if (entry.startsWith(".") || entry.startsWith("_") || entry === "__tests__") continue
    if (isClientFile(entry)) continue

    const filePath = path.join(dir, entry)
    const stat = yield* fs.stat(filePath)

    if (stat.type === "File" && isExtensionFile(entry)) {
      paths.push(filePath)
    } else if (stat.type === "Directory") {
      // Check for index.ts/index.js in subdirectory
      for (const indexName of ["index.ts", "index.js", "index.mjs"]) {
        const indexPath = path.join(filePath, indexName)
        const indexExists = yield* fs.exists(indexPath)
        if (indexExists) {
          paths.push(indexPath)
          break
        }
      }
    }
  }

  return paths.sort()
})

// Loading — import extension files via Bun native import()

// gent/no-dynamic-imports: allow extension modules are discovered from user/project files at runtime
const importExtensionModule = (filePath: string) => import(filePath)

/** Load a single extension from a file path. */
const loadExtensionFile = Effect.fn("ExtensionLoader.loadExtensionFile")(function* (
  filePath: string,
) {
  const mod = yield* Effect.tryPromise({
    try: () => importExtensionModule(filePath),
    catch: (err) =>
      new ExtensionLoadError({
        extensionId: ExtensionId.make("unknown"),
        message: `Failed to import ${filePath}: ${String(err)}`,
        cause: err,
      }),
  })

  // Find the extension — check default export, then named exports
  const candidates: LoadedUserExtension[] = []
  const seen = new Set<unknown>()

  if (!Predicate.isUndefined(mod["default"])) {
    const resolved = resolveToGentExtension(mod["default"])
    if (Option.isSome(resolved) && !seen.has(resolved.value)) {
      seen.add(resolved.value)
      candidates.push(resolved.value)
    }
  }

  for (const [, value] of Object.entries(mod)) {
    const resolved = resolveToGentExtension(value)
    if (Option.isSome(resolved) && !seen.has(resolved.value)) {
      seen.add(resolved.value)
      candidates.push(resolved.value)
    }
  }

  if (candidates.length === 0) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `No GentExtension found in ${filePath}. Export a defineExtension() result as default or named export.`,
    })
  }

  if (candidates.length > 1) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `Multiple GentExtension exports found in ${filePath}. Export exactly one.`,
    })
  }

  // candidates.length === 1 guaranteed by checks above
  const result = candidates[0]
  if (Predicate.isUndefined(result)) {
    return yield* new ExtensionLoadError({
      extensionId: ExtensionId.make("unknown"),
      message: `No extension in ${filePath}`,
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
// oxlint-disable-next-line effect/noUnknownParameters -- Runtime module exports enter as untyped values.
const isGentExtension = (value: unknown): value is LoadedUserExtension => {
  const decoded = decodeGentExtensionContract(value)
  return Option.isSome(decoded) && Effect.isEffect(decoded.value.setup)
}

/** Extract GentExtension from a module export. Paired-package wrapping is gone;
 *  only raw `GentExtension` values are valid now. */
// oxlint-disable-next-line effect/noUnknownParameters -- Runtime module exports enter as untyped values.
const resolveToGentExtension = (value: unknown): Option.Option<LoadedUserExtension> => {
  if (isGentExtension(value)) return Option.some(value)
  return Option.none()
}

// Full discovery + loading pipeline

export interface DiscoveredExtension {
  readonly extension: LoadedUserExtension
  readonly scope: ExtensionScope
  readonly sourcePath: string
}

interface SkippedExtension {
  readonly path: string
  readonly scope: ExtensionScope
  readonly error: string
}

/** Discover and load extensions from all configured directories. Per-file isolation — one broken file does not suppress siblings. */
export const discoverExtensions = Effect.fn("ExtensionLoader.discoverExtensions")(function* (opts: {
  readonly userDir: string // ~/.gent/extensions
  readonly projectDir: string // .gent/extensions
}) {
  const userPaths = yield* discoverDir(opts.userDir)
  const projectPaths = yield* discoverDir(opts.projectDir)
  const projectTrusted = yield* isProjectExtensionDirectoryTrusted(opts)

  const loaded: DiscoveredExtension[] = []
  const skipped: SkippedExtension[] = []

  /** Load one scope's files; a broken file is skipped, its siblings still load. */
  const loadScope = Effect.fn("ExtensionLoader.loadScope")(function* (
    paths: ReadonlyArray<string>,
    scope: ExtensionScope,
  ) {
    for (const filePath of paths) {
      const result = yield* loadExtensionFile(filePath).pipe(Effect.result)
      if (Result.isSuccess(result)) {
        loaded.push({ extension: result.success, scope, sourcePath: filePath })
        continue
      }
      const error = result.failure.message
      skipped.push({ path: filePath, scope, error })
      yield* Effect.logWarning("extension.load.skipped").pipe(
        Effect.annotateLogs({ path: filePath, scope, error }),
      )
    }
  })

  yield* loadScope(userPaths, "user")

  // The trust check guards the whole project scope, so it sits ahead of the loop.
  if (projectTrusted) {
    yield* loadScope(projectPaths, "project")
  } else {
    const error =
      "Project code is not trusted. Add its canonical root to trustedProjects in the user config."
    for (const filePath of projectPaths) {
      skipped.push({ path: filePath, scope: "project", error })
      yield* Effect.logWarning("extension.load.untrusted").pipe(
        Effect.annotateLogs({ path: filePath, error }),
      )
    }
  }

  return { loaded, skipped }
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
    source: discovered.sourcePath,
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
  // A setup that returns a value is the old contribution-object contract. Loading
  // it as an empty extension would silently drop everything it meant to add.
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

export const setupExtensions = (params: {
  readonly extensions: ReadonlyArray<DiscoveredExtension>
  readonly cwd: string
  readonly home: string
  readonly disabled: ReadonlySet<string>
}): Effect.Effect<ExtensionActivationResult, never, ExtensionLoaderServices> =>
  Effect.gen(function* () {
    const active: LoadedExtension[] = []
    const failed: FailedExtension[] = []

    for (const discovered of params.extensions) {
      if (params.disabled.has(discovered.extension.manifest.id)) {
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

    return { active, failed }
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
      const seen = new Set<string>()
      for (const item of pickItems(ext.contributions)) {
        const key = getKey(item)
        if (Option.isNone(key)) continue
        if (seen.has(key.value)) continue
        seen.add(key.value)
        const existing = scopeMap.get(key.value) ?? []
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

  // Tool collisions: same-scope same-id model-callable tool leaves.
  collectScopedCollisions(
    (cs) => cs.tools ?? [],
    (cap) => {
      if (isToolCapability(cap)) {
        return Option.some(getToolMetadata(cap).id)
      }
      return Option.none()
    },
    "tool",
  )
  collectScopedCollisions(
    (cs) => cs.requests ?? [],
    (cap) => Option.some(cap.id),
    "rpc",
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
    (cs) => cs.externalDrivers ?? [],
    (driver) => Option.some(driver.id),
    "external driver",
  )
  // Static prompt sections live on capability leaf `prompt`. Collision check
  // uses prompt-section id dedup.
  collectScopedCollisions(
    (cs) => {
      const sections: PromptSection[] = []
      for (const tool of cs.tools ?? []) {
        if (!isToolCapability(tool)) continue
        const prompt = Option.fromUndefinedOr(getToolMetadata(tool).prompt)
        if (Option.isSome(prompt)) sections.push(prompt.value)
      }
      for (const rpc of cs.requests ?? []) {
        const prompt = Option.fromUndefinedOr(rpc.prompt)
        if (Option.isSome(prompt)) sections.push(prompt.value)
      }
      return sections
    },
    (section) => Option.some(section.id),
    "prompt section",
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Resource services are heterogeneous at this explicit host membrane.
type RuntimeProfileServiceContext = Context.Context<any>

/** Services and immutable prompt inputs built for one session. */
export interface SessionProfile {
  readonly cwd: string
  readonly resolved: ResolvedExtensions
  readonly layerContext: RuntimeProfileServiceContext
  readonly registryService: ExtensionRegistryService
  readonly driverRegistryService: DriverRegistryService
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
 * This boundary only guarantees that it does not build Resource layers,
 * invoke Resource start/stop hooks.
 */
interface RuntimeProfileDeclarations {
  readonly extensionDeclarations: ExtensionActivationResult
  readonly coreSections: ReadonlyArray<PromptSection>
}

export const loadRuntimeProfileDeclarations = (
  inputs: RuntimeProfileInputs,
): Effect.Effect<
  RuntimeProfileDeclarations,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner | GentPlatform
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const canonicalCwd = path.resolve(inputs.cwd)

    // 1. Disabled set, already merged by the caller
    const disabledSet = new Set(inputs.disabledExtensions ?? [])

    // 2. Discover external extensions (user + project dirs)
    const userExtensionsDir = path.join(inputs.home, GENT_CONFIG_DIRECTORY, "extensions")
    const projectExtensionsDir = path.join(canonicalCwd, GENT_CONFIG_DIRECTORY, "extensions")
    const discovery = yield* discoverExtensions({
      userDir: userExtensionsDir,
      projectDir: projectExtensionsDir,
    }).pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("runtime-profile.extension.discovery.failed").pipe(
          Effect.annotateLogs({ error: String(error), cwd: canonicalCwd }),
          Effect.as({ loaded: [], skipped: [] }),
        ),
      ),
    )

    if (discovery.skipped.length > 0) {
      yield* Effect.logWarning("runtime-profile.extension.discovery.summary").pipe(
        Effect.annotateLogs({
          loaded: String(discovery.loaded.length),
          skipped: String(discovery.skipped.length),
          cwd: canonicalCwd,
        }),
      )
    }

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

    // 4. Validate declarations without acquiring process resources.
    const extensionDeclarations = yield* validateLoadedExtensions(setup.active)
    const declarations: ExtensionActivationResult = {
      active: extensionDeclarations.active,
      failed: [...setup.failed, ...extensionDeclarations.failed],
    }
    // 5. Build base prompt sections (core writes the environment; extensions shadow by id)
    const isGitRepo = yield* fs
      .exists(path.join(canonicalCwd, ".git"))
      .pipe(Effect.catchEager(() => Effect.succeed(false)))
    const date = DateTime.formatIsoDateUtc(yield* DateTime.now)
    const coreSections = [
      environmentSection({
        cwd: canonicalCwd,
        platform: inputs.platform,
        date,
        shell: inputs.shell,
        osVersion: inputs.osVersion,
        isGitRepo,
      }),
    ]

    return {
      extensionDeclarations: declarations,
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
}) =>
  Effect.gen(function* () {
    // Every resource is already built. Supplying that immutable context here is
    // the only resource-side operation in staging.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The host membrane erases heterogeneous resource services at this boundary.
    const resourceLayer: Layer.Layer<any, never, never> = Layer.succeedContext(
      params.resourceContext,
    )
    const baseLayers = Layer.mergeAll(
      ExtensionRegistry.fromResolved(params.resolved),
      DriverRegistry.fromResolved({
        modelDrivers: params.resolved.modelDrivers,
        externalDrivers: params.resolved.externalDrivers,
      }),
    )
    const layerContext = yield* Layer.build(Layer.provideMerge(resourceLayer, baseLayers))
    // Extension sections shadow core sections by id.
    const sectionMap = new Map(params.coreSections.map((s) => [s.id, s]))
    for (const s of params.resolved.promptSections.values()) sectionMap.set(s.id, s)
    return {
      cwd: params.cwd,
      resolved: params.resolved,
      layerContext,
      registryService: Context.get(layerContext, ExtensionRegistry),
      driverRegistryService: Context.get(layerContext, DriverRegistry),
      baseSections: [...sectionMap.values()],
      generationId: params.generationId,
    } satisfies SessionProfile
  })

// ── session-profile ─────────────────────────────────────────────────────────

/**
 * SessionProfile — per-(workspace,cwd) live profile for shared server mode.
 *
 * Each cache entry is built once. Declarations are loaded, every extension's
 * process resources are built into a scope that closes with the server, and
 * the catalog is staged from the resulting context. An extension whose process
 * resource fails to build is reported as a failed extension and the rest of the
 * profile stays live.
 */

// ── SessionProfileCache ──

interface SessionProfileCacheConfig {
  readonly home: string
  readonly platform: string
  readonly shell?: string
  readonly osVersion?: string
  readonly disabledExtensions?: ReadonlyArray<string>
  readonly extensions: ReadonlyArray<GentExtension<ExtensionSetupServices>>
}

export interface SessionProfileCacheService {
  /** Get or lazily create a profile for the given cwd. */
  readonly resolve: (cwd: string) => Effect.Effect<SessionProfile>
}

const cacheKey = (workspaceId: WorkspaceId, cwd: string): string => `${workspaceId}\u0000${cwd}`

const effectiveInputs = (
  inputs: RuntimeProfileInputs,
  config: UserConfig,
): RuntimeProfileInputs => {
  const configDisabled = Option.getOrElse(
    Option.fromUndefinedOr(config.disabledExtensions),
    () => [],
  )
  const explicitDisabled = Option.getOrElse(
    Option.fromUndefinedOr(inputs.disabledExtensions),
    () => [],
  )
  return {
    ...inputs,
    disabledExtensions: [...explicitDisabled, ...configDisabled],
  }
}

interface StartedProcessResources {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
  readonly context: Context.Context<unknown>
}

/**
 * Build every extension's process resources in resolution order, so a later
 * extension's service wins exactly as it does in the registry. Each extension
 * gets its own child scope so a failed build releases only what it acquired;
 * the extension is then reported as failed at the startup phase instead of
 * taking the whole profile down.
 */
const startProcessResources = (
  extensions: ReadonlyArray<LoadedExtension>,
  baseContext: Context.Context<unknown>,
  profileScope: Scope.Scope,
): Effect.Effect<StartedProcessResources> =>
  Effect.gen(function* () {
    let context = baseContext
    const active: Array<LoadedExtension> = []
    const failed: Array<FailedExtension> = []
    for (const extension of sortExtensionsByScope(extensions)) {
      if (collectResourceEntries([extension], "process").length === 0) {
        active.push(extension)
        continue
      }
      const extensionScope = yield* Scope.fork(profileScope)
      const built = yield* Layer.build(buildResourceLayer([extension], "process")).pipe(
        Effect.provideContext(context),
        Effect.provideService(Scope.Scope, extensionScope),
        Effect.exit,
      )
      if (Exit.isSuccess(built)) {
        context = Context.merge(context, built.value)
        active.push(extension)
        continue
      }
      const error = Cause.pretty(built.cause)
      yield* Scope.close(extensionScope, built)
      yield* Effect.logError("session-profile.resource.failed").pipe(
        Effect.annotateLogs({ extensionId: extension.manifest.id, error }),
      )
      failed.push(toFailedExtension(extension, "startup", error))
    }
    return { active, failed, context }
  })

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
    | ConfigService
    | ScopeType.Scope
    | GentPlatform
  > =>
    Layer.effect(
      SessionProfileCache,
      Effect.gen(function* () {
        const configService = yield* ConfigService
        const fs = yield* FileSystem.FileSystem
        const pathSvc = yield* Path.Path
        const spawner = yield* ChildProcessSpawner
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
          Context.add(ConfigService, configService),
          Context.add(GentPlatform, platform),
        )

        const profiles = new Map<string, SessionProfile>()
        // The gate only protects creation of per-key locks. Building one cwd
        // must not block unrelated cwd or workspace keys.
        const locks = new Map<string, Semaphore.Semaphore>()
        const lockGate = yield* Semaphore.make(1)
        const lockFor = (key: string) =>
          Effect.gen(function* () {
            const existing = Option.fromNullishOr(locks.get(key))
            if (Option.isSome(existing)) return existing.value
            const created = yield* Semaphore.make(1)
            locks.set(key, created)
            return created
          }).pipe(lockGate.withPermits(1))

        const inputsFor = (cwd: string): RuntimeProfileInputs => ({
          cwd,
          home: config.home,
          platform: config.platform,
          shell: config.shell,
          osVersion: config.osVersion,
          extensions: config.extensions,
          disabledExtensions: config.disabledExtensions,
        })

        const buildProfile = (cwd: string) =>
          Effect.gen(function* () {
            const profileScope = yield* Scope.fork(serverScope)
            return yield* Effect.gen(function* () {
              const userConfig = yield* configService.getFresh(cwd)
              const declarations = yield* loadRuntimeProfileDeclarations(
                effectiveInputs(inputsFor(cwd), userConfig),
              ).pipe(Effect.provideContext(platformServicesContext))
              const started = yield* startProcessResources(
                declarations.extensionDeclarations.active,
                platformServicesContext,
                profileScope,
              )
              const resolved = resolveExtensions(started.active, [
                ...declarations.extensionDeclarations.failed,
                ...started.failed,
              ])
              return yield* buildSessionProfile({
                cwd,
                resolved,
                coreSections: declarations.coreSections,
                resourceContext: started.context,
                generationId,
              })
            }).pipe(
              Effect.provideService(Scope.Scope, profileScope),
              // A failed or interrupted build releases everything it acquired.
              Effect.onError((cause) => Scope.close(profileScope, Exit.failCause(cause))),
            )
          })

        const resolve: SessionProfileCacheService["resolve"] = (cwd) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const canonicalCwd = pathSvc.resolve(cwd)
            const key = cacheKey(workspaceId, canonicalCwd)
            const cached = Option.fromNullishOr(profiles.get(key))
            if (Option.isSome(cached)) return cached.value
            const lock = yield* lockFor(key)
            return yield* Effect.gen(function* () {
              const found = Option.fromNullishOr(profiles.get(key))
              if (Option.isSome(found)) return found.value
              const profile = yield* buildProfile(canonicalCwd).pipe(Effect.orDie)
              profiles.set(key, profile)
              yield* Effect.logInfo("session-profile.initialized").pipe(
                Effect.annotateLogs({
                  cwd: profile.cwd,
                  extensionCount: profile.resolved.extensions.length,
                  sectionCount: profile.baseSections.length,
                }),
              )
              return profile
            }).pipe(lock.withPermits(1))
          })

        return SessionProfileCache.of({ resolve })
      }),
    )

  static Test = (profiles?: Map<string, SessionProfile>): Layer.Layer<SessionProfileCache> => {
    const cache = Option.getOrElse(
      Option.fromUndefinedOr(profiles),
      () => new Map<string, SessionProfile>(),
    )
    return Layer.succeed(
      SessionProfileCache,
      SessionProfileCache.of({
        resolve: (cwd) =>
          Effect.sync(() => {
            const existing = Option.fromUndefinedOr(cache.get(cwd))
            if (Option.isSome(existing)) return existing.value
            const resolved = resolveExtensions([])
            const layerContext = Effect.runSync(
              Layer.build(
                Layer.mergeAll(
                  ExtensionRegistry.fromResolved(resolved),
                  DriverRegistry.fromResolved({
                    modelDrivers: resolved.modelDrivers,
                    externalDrivers: resolved.externalDrivers,
                  }),
                ),
              ).pipe(Effect.scoped),
            )
            const profile: SessionProfile = {
              cwd,
              resolved,
              layerContext,
              registryService: Context.get(layerContext, ExtensionRegistry),
              driverRegistryService: Context.get(layerContext, DriverRegistry),
              baseSections: [],
              generationId: ProcessGenerationId.make("test"),
            }
            cache.set(cwd, profile)
            return profile
          }),
      }),
    )
  }
}

// ── approval-service ────────────────────────────────────────────────────────

/**
 * Layer-scoped approval service.
 *
 * Wraps `makeInteractionService` with the fixed approval schema.
 * Long-lived — one instance per server scope, so storedResolutions
 * survive across tool re-executions for cold resume.
 *
 * Tools access this indirectly via `ctx.interaction.approve()` on ToolCapabilityContext.
 */

const makeApprovalInteractionService: Effect.Effect<
  InteractionService,
  never,
  EventPublisher | GentPlatform | InteractionStorage
> = Effect.gen(function* () {
  const store = yield* InteractionStorage
  const storage: InteractionStorageConfig = {
    persist: (record) =>
      Effect.gen(function* () {
        // A dispatching tool owns the interactions its inner calls raise, so
        // they are written to its receipt. Core does not know which tools
        // those are; an absent owner is a direct call.
        const owner = yield* Effect.serviceOption(CurrentInteractionOwner)
        if (Option.isSome(owner)) {
          yield* owner.value.persist(record)
        } else {
          yield* store.persist(record)
        }
      }).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new EventStoreError({ message: "Failed to persist interaction request", cause }),
        ),
      ),
    resolve: (requestId) => store.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
    decide: (requestId, decisionJson) =>
      store
        .decide(requestId, decisionJson)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EventStoreError({ message: "Failed to persist interaction decision", cause }),
          ),
        ),
  }
  const eventPublisher = yield* EventPublisher
  const service = yield* makeInteractionService({
    onPresent: (requestId, params, ctx) =>
      eventPublisher.publish(
        InteractionPresented.make({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          requestId,
          text: params.text,
          metadata: params.metadata,
        }),
      ),
    storage,
  })
  return {
    ...service,
    present: Effect.fn("ApprovalService.present")(function* (params, ctx) {
      // An interaction raised inside a dispatching tool belongs to that
      // tool's receipt, not to the branch's native replay. Absent owner is
      // the common case: a direct tool call takes the native path.
      const owner = yield* Effect.serviceOption(CurrentInteractionOwner)
      if (Option.isNone(owner)) return yield* service.present(params, ctx)
      if (owner.value.sessionId !== ctx.sessionId || owner.value.branchId !== ctx.branchId)
        return yield* new EventStoreError({
          message: "The owning call belongs to another branch",
        })
      return yield* service.present(params, {
        ...ctx,
        resumeRequestId: yield* owner.value.resumeRequestId,
      })
    }),
  }
})

interface ApprovalServiceApi extends InteractionService {}

export class ApprovalService extends Context.Service<ApprovalService, ApprovalServiceApi>()(
  "@gent/core/src/runtime/extension-host/ApprovalService",
) {
  static Live: Layer.Layer<
    ApprovalService,
    never,
    EventPublisher | GentPlatform | InteractionStorage
  > = Layer.effect(ApprovalService, makeApprovalInteractionService)

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
        pendingRequestId: () =>
          Effect.sync(() => Option.getOrUndefined(Option.none<InteractionRequestId>())),
        storeResolution: () => Effect.void,
        rehydrate: () => Effect.void,
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
  }) => Effect.Effect<void, Error>
  readonly dequeueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<boolean, Error>
  /** One user message on another branch's loop. */
  readonly send: (input: SendUserMessagePayload) => Effect.Effect<void, Error>
  readonly steer: (command: SteerCommandType) => Effect.Effect<void, Error>
}

/** Decoding entity ids is cheap; bound it so a large registry does not stall a listing. */
const ACTIVE_LOOP_DECODE_CONCURRENCY = 8

interface ExtensionHostContextInput {
  readonly extensionRegistry: ExtensionRegistryService
  /** Built by the caller over `GentPlatform`, which is an Effect rather than a service Tag. */
  readonly host: ExtensionHostPlatform
  /** The loop's follow-up queue. Absent outside a loop. */
  readonly sessionControl?: ExtensionSessionControlService
}

interface MakeExtensionHostContextRunInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /** Session-scoped cwd. Falls back to RuntimeEnvironment.cwd when absent. */
  readonly sessionCwd?: string
}

interface ExtensionHostContextProviderService {
  readonly defaultExtensionRegistry: ExtensionRegistryService
  readonly forRun: (
    runInfo: MakeExtensionHostContextRunInfo,
    extensionRegistry?: ExtensionRegistryService,
  ) => ExtensionHostContext
}

export class ExtensionHostContextProvider extends Context.Service<
  ExtensionHostContextProvider,
  ExtensionHostContextProviderService
>()("@gent/core/src/runtime/extension-host/ExtensionHostContextProvider") {}

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

const unavailablePlatform: RuntimeEnvironmentApi = { cwd: "", home: "", platform: "unknown" }

export const makeExtensionHostContextProvider = (
  input: ExtensionHostContextInput,
): Effect.Effect<ExtensionHostContextProviderService> =>
  Effect.gen(function* () {
    const platform = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeEnvironment),
      () => unavailablePlatform,
    )
    const host = input.host
    const control = via(Option.fromUndefinedOr(input.sessionControl), "SessionControl")
    const approval = yield* facet(ApprovalService, "ApprovalService")
    const publisher = yield* facet(EventPublisher, "EventPublisher")
    const sql = yield* facet(SqlClient.SqlClient, "SqlClient")
    const sessions = yield* facet(SessionStorage, "SessionStorage")
    const branches = yield* facet(BranchStorage, "BranchStorage")
    const messages = yield* facet(MessageStorage, "MessageStorage")
    const relationships = yield* facet(RelationshipStorage, "RelationshipStorage")
    const agents = yield* facet(AgentRunnerService, "AgentRunnerService")
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

    const Process: ExtensionProcessService = {
      randomId: host.randomId,
      run: (command, args, options) =>
        mapExtensionServiceError(
          "ExtensionProcess",
          "run",
          host.runProcess(command, args, options),
        ),
      parentEnv: host.parentEnv,
    }

    // The file facets read their platform services optionally, so a root that
    // ships no file system still assembles a context; the facet reports the
    // absence only when something calls it.
    const fs = yield* facet(FileSystem.FileSystem, "FileSystem")
    const pathOption = yield* Effect.serviceOption(Path.Path)
    // `resolve`, `join` and `dirname` are synchronous in the facet, so an
    // absent path service can only be reported as a defect at call time.
    const onPath = <A>(use: (path: Path.Path) => A): A =>
      Option.match(pathOption, {
        onNone: (): A => {
          // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- The facet's path helpers are synchronous, so an unwired path service can only surface as a defect here.
          throw new Error("Path not available")
        },
        onSome: use,
      })
    const writeFile = (
      fileSystem: FileSystem.FileSystem,
      path: string,
      content: string,
      options?: { readonly atomic?: boolean },
    ) =>
      makeFileWriter(fileSystem, (target) => onPath((p) => p.dirname(target)))(
        path,
        content,
        options,
      )
    const Files: ExtensionFilesService = {
      read: (path) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "read",
          fs((s) => s.readFileString(path)),
        ),
      write: (path, content, options) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "write",
          fs((s) => writeFile(s, path, content, options)),
        ),
      exists: (path) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "exists",
          fs((s) => s.exists(path)),
        ),
      stat: (path) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "stat",
          fs((s) =>
            s.stat(path).pipe(
              Effect.map((info) => ({
                type: info.type,
                size: info.size,
                mtime: Option.getOrUndefined(info.mtime),
              })),
            ),
          ),
        ),
      makeDirectory: (path, options) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "makeDirectory",
          fs((s) => s.makeDirectory(path, options)),
        ),
      resolve: (...paths) => onPath((p) => p.resolve(...paths)),
      join: (...paths) => onPath((p) => p.join(...paths)),
      dirname: (path) => onPath((p) => p.dirname(path)),
    }

    const fileLockOption = yield* Effect.serviceOption(FileLockService)
    const FileLock: ExtensionFileLockServiceApi = Option.match(fileLockOption, {
      onNone: () => ({ withLock: (_path, effect) => effect }),
      onSome: (fileLock) => ({ withLock: (path, effect) => fileLock.withLock(path, effect) }),
    })

    const statePublisherOption = yield* Effect.serviceOption(ExtensionStatePublisher)

    const forRun = (
      runInfo: MakeExtensionHostContextRunInfo,
      extensionRegistry: ExtensionRegistryService = input.extensionRegistry,
    ): ExtensionHostContext => ({
      sessionId: runInfo.sessionId,
      branchId: runInfo.branchId,
      cwd: runInfo.sessionCwd ?? platform.cwd,
      home: platform.home,
      host,
      Process,
      Files,
      FileLock,

      State: ((extensionId) =>
        Option.match(statePublisherOption, {
          onNone: () => ({ changed: () => Effect.void }),
          onSome: (statePublisher) =>
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
                  mapExtensionServiceError(
                    "ExtensionState",
                    "changed",
                    inWorkspace(
                      statePublisher.changed({
                        extensionId: id,
                        sessionId: runInfo.sessionId,
                        branchId: runInfo.branchId,
                      }),
                    ),
                  ),
              }),
            }),
        })) satisfies ExtensionStateFacet,

      Agent: {
        listAgents: Effect.succeed([...extensionRegistry.getResolved().agents.values()]),
        start: (params) =>
          agents((runner) =>
            runner.start({
              ...params,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
              cwd: params.cwd ?? runInfo.sessionCwd ?? platform.cwd,
            }),
          ),
        inspect: (params) =>
          agents((runner) =>
            runner.inspect({
              requestId: params.requestId,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
            }),
          ),
        list: () =>
          agents((runner) =>
            runner.list({
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
            }),
          ),
        cancel: (params) =>
          agents((runner) =>
            runner.cancel({
              requestId: params.requestId,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
            }),
          ),
        send: (params) =>
          agents((runner) =>
            runner.send({
              ...params,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
            }),
          ),
        run: (params) =>
          agents((runner) =>
            runner.run({
              agent: params.agent,
              prompt: params.prompt,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
              cwd: params.cwd ?? runInfo.sessionCwd ?? platform.cwd,
              runSpec: params.runSpec,
              observe: params.observe,
            }),
          ).pipe(Effect.mapError(extensionServiceError("ExtensionAgent", "run"))),
      },

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
        renameCurrent: (name) =>
          mutations((service) =>
            service.renameSession({ sessionId: runInfo.sessionId, name }),
          ).pipe(Effect.mapError(sessionError("renameCurrent")), inWorkspace),
        create: (params) =>
          mutations((service) =>
            service.createSession({
              name: params.name,
              cwd: params.cwd ?? runInfo.sessionCwd ?? platform.cwd,
              parentSessionId: params.parentSessionId,
              parentBranchId: params.parentBranchId,
              historyBranchId: params.historyBranchId,
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
          Effect.gen(function* () {
            if (params.sessionId === runInfo.sessionId && params.branchId === runInfo.branchId) {
              return yield* new ExtensionServiceError({
                service: "ExtensionSession",
                operation: "send",
                message: "send targets another branch; queue a follow-up on this one",
              })
            }
            yield* requireTarget("send", params)
            yield* control((loop) => loop.send(params)).pipe(Effect.mapError(sessionError("send")))
          }).pipe(inWorkspace),
        steer: (command) =>
          requireTarget("steer", command).pipe(
            Effect.andThen(
              control((loop) => loop.steer(command)).pipe(Effect.mapError(sessionError("steer"))),
            ),
            inWorkspace,
          ),
        // The subscription does its reads at pull time, so the workspace is
        // pinned on the stream, not on the effect that builds it.
        events: (target) =>
          Stream.unwrap(
            eventStore((store) =>
              Effect.succeed(
                store.subscribe({ ...target, synchronize: true }).pipe(
                  Stream.map((envelope) => envelope.event),
                  Stream.mapError(sessionError("events")),
                ),
              ),
            ),
          ).pipe(Stream.provideService(CurrentWorkspaceId, workspaceId)),
        queueFollowUp: (params) => {
          const target = {
            sessionId: params.sessionId ?? runInfo.sessionId,
            branchId: params.branchId ?? runInfo.branchId,
          }
          return requireTarget("queueFollowUp", target).pipe(
            Effect.andThen(
              control((loop) =>
                loop.queueFollowUp({
                  ...target,
                  sourceId: params.sourceId,
                  content: params.content,
                  metadata: params.metadata,
                  wake: params.wake,
                }),
              ).pipe(Effect.mapError(sessionError("queueFollowUp"))),
            ),
            inWorkspace,
          )
        },
        dequeueFollowUp: (params) => {
          const target = {
            sessionId: params.sessionId ?? runInfo.sessionId,
            branchId: params.branchId ?? runInfo.branchId,
          }
          return requireTarget("dequeueFollowUp", target).pipe(
            Effect.andThen(
              control((loop) =>
                loop.dequeueFollowUp({ ...target, sourceId: params.sourceId }),
              ).pipe(Effect.mapError(sessionError("dequeueFollowUp"))),
            ),
            inWorkspace,
          )
        },
        listBranches: branches((storage) => storage.listBranches(runInfo.sessionId)).pipe(
          Effect.mapError(sessionError("listBranches")),
          inWorkspace,
        ),
        listSessions: sessions((storage) => storage.listSessions).pipe(
          Effect.mapError(sessionError("listSessions")),
          inWorkspace,
        ),
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
                  Effect.map((state) => Option.some(state._tag)),
                  Effect.catchEager(() => Effect.succeed(Option.none<string>())),
                  Effect.provideService(ActorStateRegistry, stateRegistry),
                  Effect.map((status) => ({ ...loop, status })),
                ),
              { concurrency: ACTIVE_LOOP_DECODE_CONCURRENCY },
            )
          }),
        ).pipe(Effect.mapError(sessionError("listActiveLoops")), inWorkspace),
      },

      Interaction: {
        approve: (params) =>
          mapInteraction(
            "approve",
            approval((service) =>
              service.present(params, { sessionId: runInfo.sessionId, branchId: runInfo.branchId }),
            ),
          ),
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
                    publisher((events) => events.append(MessageReceived.make({ message }))),
                  ),
                  client.withTransaction,
                ),
              )
              yield* publisher((events) => events.deliver(envelope))
            }),
          ),
      },
    })

    return { defaultExtensionRegistry: input.extensionRegistry, forRun }
  })

// ── session-runtime-context ─────────────────────────────────────────────────

export interface TurnProfileDefaults {
  readonly driverRegistry: DriverRegistryService
  readonly baseSections: ReadonlyArray<PromptSection>
}

interface ExistingSessionBranch {
  readonly session: Session
  readonly branch: Branch
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

/**
 * Resolve the turn profile for one branch: the stored session cwd selects a
 * profile from the cache; without a session or a cache, the host defaults
 * apply. A storage lookup failure falls back to the defaults as well.
 */
export const resolveTurnProfile = (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly profileCache?: SessionProfileCacheService
  readonly defaults: TurnProfileDefaults
}): Effect.Effect<AgentLoopTurnProfile, never, ExtensionHostContextProvider | SessionStorage> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const hostProvider = yield* ExtensionHostContextProvider
    const sessionCwd = yield* sessionStorage.getSession(params.sessionId).pipe(
      Effect.map((session) => Option.fromUndefinedOr(session?.cwd)),
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    const runInfo = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      sessionCwd: Option.getOrUndefined(sessionCwd),
    }
    const profile = yield* Option.match(
      Option.all([Option.fromUndefinedOr(params.profileCache), sessionCwd]),
      {
        onNone: () => Effect.succeedNone,
        onSome: ([profileCache, cwd]) => profileCache.resolve(cwd).pipe(Effect.asSome),
      },
    )
    if (Option.isNone(profile)) {
      return {
        turnExtensionRegistry: hostProvider.defaultExtensionRegistry,
        turnDriverRegistry: params.defaults.driverRegistry,
        turnBaseSections: params.defaults.baseSections,
        turnHostCtx: hostProvider.forRun(runInfo),
      }
    }
    return {
      turnExtensionRegistry: profile.value.registryService,
      turnDriverRegistry: profile.value.driverRegistryService,
      turnBaseSections: profile.value.baseSections,
      turnHostCtx: hostProvider.forRun(runInfo, profile.value.registryService),
      turnCapabilityContext: profile.value.layerContext,
      turnGenerationId: profile.value.generationId,
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
