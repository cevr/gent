import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
} from "effect"
import {
  type AnyExtensionHook,
  type AnyResourceContribution,
  type ExtensionContext,
  type ExtensionContributions,
  type ExtensionHook,
  ExtensionHost,
  type ExtensionHostContext,
  type ExtensionHostPlatform,
  ExtensionHostProcessError,
  ExtensionLoadError,
  type ExtensionLoaderServices,
  type ExtensionScope,
  type ExtensionSetupServices,
  type ExtensionStatusInfo,
  type ExtensionTurnContext,
  type FailedExtension,
  type FailedExtensionPhase,
  type GentExtension,
  isClientFile,
  type LoadedExtension,
  makeCollectingExtensionHost,
  provideExtensionServices,
  type ResourceScope,
  sealRuntimeLoadedEffect,
  sortExtensionsByScope,
  type SystemPromptInput,
  type ToolPolicyFragment,
  type TurnAfterInput,
  validateExtensionPackage,
} from "../domain/extension.js"
import { ExtensionId, type RpcId, type ToolCallId } from "../domain/ids.js"
import {
  bindRequestCapabilityExtension,
  type CapabilityError,
  CapabilityError as CapabilityErrorClass,
  type CapabilityNotFoundError,
  CapabilityNotFoundError as CapabilityNotFoundErrorClass,
  getToolId,
  getToolMetadata,
  isToolCapability,
  type PromptSection,
  type RequestCapability,
  type ToolCapability,
} from "../domain/capability.js"
import { type AgentDefinition, Model } from "../domain/agent.js"
import { causeMessage, omitUndefined } from "../domain/guards.js"
import {
  DriverError,
  DriverFailureId,
  type ExternalDriverContribution,
  type ModelDriverContribution,
  type ProviderAuthError,
  type ProviderAuthInfo,
} from "../domain/driver.js"
import { ChildProcessSpawner } from "effect/unstable/process"
import { GentPlatform, runProcess } from "./gent-platform.js"
import { isProjectExtensionDirectoryTrusted } from "./config.js"

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

// ── extensions/extension-capability-context ─────────────────────────────────

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

// ── extensions/extension-effect-membrane ────────────────────────────────────

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

// ── extensions/extension-hooks ──────────────────────────────────────────────

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

// ── extensions/registry ─────────────────────────────────────────────────────

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

export interface ResolvedExtensions {
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

// ── extensions/driver-registry ──────────────────────────────────────────────

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
  /** Run a base catalog through every model driver's `listModels` filter. */
  readonly filterModelCatalog: (
    baseCatalog: ReadonlyArray<Model>,
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
        filterModelCatalog: Effect.fn("DriverRegistry.filterModelCatalog")(function* (
          baseCatalog: ReadonlyArray<Model>,
          resolveAuth?: (
            driverId: string,
            // oxlint-disable-next-line effect/noNullish -- Driver auth callbacks may have no auth result.
          ) => Effect.Effect<ProviderAuthInfo | undefined, ProviderAuthError>,
        ) {
          let catalog = baseCatalog
          for (const driver of resolved.modelDrivers.values()) {
            if (Predicate.isUndefined(driver.listModels)) continue
            let auth = Option.none<ProviderAuthInfo>()
            if (!Predicate.isUndefined(resolveAuth)) {
              auth = yield* resolveAuth(driver.id).pipe(Effect.map(Option.fromUndefinedOr))
            }
            const nextCatalog = driver.listModels(catalog, Option.getOrUndefined(auth))
            const decoded = decodeModelCatalog(nextCatalog)
            if (decoded._tag === "None") {
              return yield* new DriverError({
                driver: DriverFailureId.make(driver.id),
                reason: `Model driver "${driver.id}" returned an invalid model catalog`,
              })
            }
            catalog = decoded.value
          }
          return catalog
        }),
      }),
    )
}

// ── extensions/resource-host/resource-layer ─────────────────────────────────

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

export const collectResourceEntries = (
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

// ── extensions/host-platform ────────────────────────────────────────────────

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
  GentPlatform | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const platform = yield* GentPlatform
  // Captured once so the facade's runProcess keeps a `never` R channel.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
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
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(toHostProcessError(command)),
      ),
  }
})

// ── extensions/loader ───────────────────────────────────────────────────────

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

// ── extensions/activation ───────────────────────────────────────────────────

export interface ExtensionActivationResult {
  readonly active: ReadonlyArray<LoadedExtension>
  readonly failed: ReadonlyArray<FailedExtension>
}

export const toFailedExtension = (
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
