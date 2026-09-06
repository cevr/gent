import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  type FileSystem,
  type Path,
  Schema,
} from "effect"
import type { AgentDefinition } from "../../domain/agent.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../../domain/driver.js"
import type { ExtensionId, RpcId } from "../../domain/ids.js"
import type { CapabilityError, CapabilityNotFoundError } from "../../domain/capability.js"
import {
  CapabilityError as CapabilityErrorClass,
  CapabilityNotFoundError as CapabilityNotFoundErrorClass,
} from "../../domain/capability.js"
import { provideExtensionServices } from "../../domain/extension-services.js"
import {
  SCOPE_PRECEDENCE,
  type ExtensionStatusInfo,
  type FailedExtension,
  type TurnProjection,
  type LoadedExtension,
  type RunContext,
  type ScheduledJobFailureInfo,
} from "../../domain/extension.js"
import { type PromptSection } from "../../domain/prompt.js"
import type { PermissionRule } from "../../domain/permission.js"
import type { RequestCapability } from "../../domain/capability/request.js"
import {
  getToolId,
  getToolMetadata,
  isToolCapability,
  type ToolCapability,
} from "../../domain/capability/tool.js"
import { compileExtensionHooks, type CompiledExtensionHooks } from "./extension-hooks.js"
import { sealErasedEffect } from "./extension-effect-membrane.js"
import { CurrentExtensionHostContext } from "../agent/current-extension-host-context.js"

// SlashCommand — public-facing slash entry. Built from `requests:` bucket
// winners that carry a `slash:` presentation block. The slash block is the
// load-bearing filter.
export interface SlashCommand {
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
  readonly permissionRules: ReadonlyArray<PermissionRule>
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

export interface CompiledRpcRegistry {
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

type ScheduledJobFailureByExtension = ReadonlyMap<string, ReadonlyArray<ScheduledJobFailureInfo>>

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

export const runExtensionCapability = (
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
  run: Effect.fn("CompiledRpcRegistry.run")(function* (extensionId, capabilityId, input) {
    const entry = resolveCapabilityEntry(entries, extensionId, capabilityId)
    if (Option.isNone(entry) || entry.value.kind !== "rpc") {
      return yield* new CapabilityNotFoundErrorClass({ extensionId, capabilityId })
    }
    const hostCtx = yield* CurrentExtensionHostContext
    return yield* provideExtensionServices(
      { ...hostCtx, extensionId },
      runExtensionCapability(extensionId, capabilityId, entry.value.capability, input),
    )
  }),
})

const sortExtensionsByScope = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const scheduledFailuresFor = (
  id: ExtensionId,
  failures: ScheduledJobFailureByExtension,
): Option.Option<ReadonlyArray<ScheduledJobFailureInfo>> => Option.fromUndefinedOr(failures.get(id))

const activeExtensionStatus = (
  extension: LoadedExtension,
  scheduledJobFailures: ScheduledJobFailureByExtension,
): ExtensionStatusInfo => {
  const base = {
    manifest: extension.manifest,
    scope: extension.scope,
    sourcePath: extension.sourcePath,
    status: "active",
  } satisfies ExtensionStatusInfo
  return Object.assign(
    base,
    Option.match(scheduledFailuresFor(extension.manifest.id, scheduledJobFailures), {
      onNone: () => ({}),
      onSome: (value) => ({ scheduledJobFailures: value }),
    }),
  )
}

const failedExtensionStatus = (
  failure: FailedExtension,
  scheduledJobFailures: ScheduledJobFailureByExtension,
): ExtensionStatusInfo => {
  const base = {
    ...failure,
    status: "failed",
  } satisfies ExtensionStatusInfo
  return Object.assign(
    base,
    Option.match(scheduledFailuresFor(failure.manifest.id, scheduledJobFailures), {
      onNone: () => ({}),
      onSome: (value) => ({ scheduledJobFailures: value }),
    }),
  )
}

export const capabilityToCommand = (
  extensionId: ExtensionId,
  cap: RequestCapability,
): SlashCommand => {
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
  return Object.assign(
    {
      name,
      extensionId,
      capabilityId: String(cap.id),
    },
    Option.match(displayName, {
      onNone: () => ({}),
      onSome: (value) => ({ displayName: value }),
    }),
    Option.match(description, {
      onNone: () => ({}),
      onSome: (value) => ({ description: value }),
    }),
    Option.match(category, {
      onNone: () => ({}),
      onSome: (value) => ({ category: value }),
    }),
    Option.match(keybind, {
      onNone: () => ({}),
      onSome: (value) => ({ keybind: value }),
    }),
  )
}

/** Compile prevalidated extensions into an immutable resolved snapshot. */
export const resolveExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  scheduledJobFailures: ScheduledJobFailureByExtension = new Map(),
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

  // Permission rules are collected from WINNERS, not raw extractions:
  // otherwise overriding `bash` without `permissionRules` would still inherit
  // builtin denies.
  const permissionRules: PermissionRule[] = []
  for (const { capability: cap } of capabilityWinners.values()) {
    if (!isToolCapability(cap)) continue
    const rules = getToolMetadata(cap).permissionRules
    if (rules) permissionRules.push(...rules)
  }
  const slashCommands = compileSlashCommands(capabilityWinners)

  const extensionHooks = compileExtensionHooks(sorted)
  const extensionStatuses: ExtensionStatusInfo[] = [
    ...sorted.map((ext) => activeExtensionStatus(ext, scheduledJobFailures)),
    ...mergedFailures.map((failure) => failedExtensionStatus(failure, scheduledJobFailures)),
  ]

  return {
    modelCapabilities,
    rpcRegistry,
    agents,
    modelDrivers,
    externalDrivers,
    promptSections: promptSectionsMap,
    permissionRules,
    slashCommands,
    extensionHooks,
    extensions: sorted,
    failedExtensions: mergedFailures,
    extensionStatuses,
  }
}

// ToolPolicy compiler — unified tool filtering + prompt section collection

export interface CompiledToolPolicy {
  readonly tools: ReadonlyArray<ToolCapability>
  readonly promptSections: ReadonlyArray<PromptSection>
}

const applyToolProjection = (
  tools: ToolCapability[],
  projection: TurnProjection,
  allToolsByName: ReadonlyMap<string, ToolCapability>,
): ToolCapability[] => {
  const policy = Option.fromUndefinedOr(projection.toolPolicy)
  if (Option.isNone(policy)) return tools

  const overrideSet = Option.fromUndefinedOr(policy.value.overrideSet)
  if (Option.isSome(overrideSet)) {
    return overrideSet.value.flatMap((name) => {
      const tool = allToolsByName.get(name)
      if (Predicate.isUndefined(tool)) return []
      return [tool]
    })
  }

  const include = Option.fromUndefinedOr(policy.value.include)
  if (Option.isSome(include)) {
    const existing = new Set(tools.map((tool) => String(getToolId(tool))))
    for (const name of include.value) {
      if (existing.has(name)) continue
      const tool = allToolsByName.get(name)
      if (Predicate.isUndefined(tool)) continue
      tools.push(tool)
      existing.add(name)
    }
  }

  const exclude = Option.fromUndefinedOr(policy.value.exclude)
  if (Option.isSome(exclude)) {
    const excludeSet = new Set(exclude.value)
    return tools.filter((tool) => !excludeSet.has(String(getToolId(tool))))
  }
  return tools
}

const collectProjectionPromptSections = (
  projections: ReadonlyArray<TurnProjection>,
): PromptSection[] => {
  const sections: PromptSection[] = []
  for (const projection of projections) {
    const promptSections = Option.fromUndefinedOr(projection.promptSections)
    if (Option.isSome(promptSections)) sections.push(...promptSections.value)
  }
  return sections
}

/**
 * Compile the active tool set and prompt sections for a turn.
 *
 * Pipeline:
 * 1. Agent allow/deny filtering
 * 2. Extension projection fragments (include/exclude/overrideSet)
 * 3. Re-apply agent deny list (extensions can't escape denials)
 * 4. Collect extension-contributed prompt sections
 */
export const compileToolPolicy = (
  allTools: ReadonlyArray<ToolCapability>,
  agent: AgentDefinition,
  runContext: RunContext,
  extensionProjections: ReadonlyArray<TurnProjection>,
): CompiledToolPolicy => {
  const allToolsByName = new Map(allTools.map((t) => [String(getToolId(t)), t]))

  // 1. Agent allow/deny filtering
  let tools = filterToolsForAgent(allTools, agent)

  // 2. Extension projection fragments (overrideSet is exclusive — include/exclude ignored when set)
  for (const projection of extensionProjections) {
    tools = applyToolProjection(tools, projection, allToolsByName)
  }

  // 4. Re-apply agent deny list — extensions can't escape denials
  tools = applyDenyFilter(tools, agent)

  // 5. Filter interactive tools in non-interactive contexts (headless, subagent)
  if (runContext.interactive === false) {
    tools = tools.filter((t) => getToolMetadata(t).interactive !== true)
  }

  return { tools, promptSections: collectProjectionPromptSections(extensionProjections) }
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
>()("@gent/core/src/runtime/extensions/registry/ExtensionRegistry") {
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

export const listSlashCommands = (resolved: ResolvedExtensions): ReadonlyArray<SlashCommand> =>
  resolved.slashCommands

// Tool filtering — pure helper for agent tool visibility

const filterToolsForAgent = (
  allTools: ReadonlyArray<ToolCapability>,
  agent: AgentDefinition,
): ToolCapability[] => {
  let tools: ToolCapability[]

  if (!Predicate.isUndefined(agent.allowedTools)) {
    const names = new Set(agent.allowedTools)
    tools = allTools.filter((t) => names.has(String(getToolId(t))))
  } else {
    tools = [...allTools]
  }

  if (!Predicate.isUndefined(agent.deniedTools)) {
    tools = applyDenyFilter(tools, agent)
  }

  return tools
}

/** Re-apply deny filter — extensions can't escape agent denials. */
const applyDenyFilter = (
  tools: ReadonlyArray<ToolCapability>,
  agent: AgentDefinition,
): ToolCapability[] => {
  if (Predicate.isUndefined(agent.deniedTools)) return [...tools]
  const denied = new Set(agent.deniedTools)
  return tools.filter((t) => !denied.has(String(getToolId(t))))
}
