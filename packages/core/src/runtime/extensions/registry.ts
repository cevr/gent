import { Context, Effect, Layer, Schema } from "effect"
import { resolveAgentModel, type AgentDefinition } from "../../domain/agent.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../../domain/driver.js"
import type { CommandId, ExtensionId, RpcId } from "../../domain/ids.js"
import type { ModelId } from "../../domain/model.js"
import type {
  CapabilityCoreContext,
  CapabilityError,
  CapabilityNotFoundError,
} from "../../domain/capability.js"
import {
  CapabilityError as CapabilityErrorClass,
  CapabilityNotFoundError as CapabilityNotFoundErrorClass,
} from "../../domain/capability.js"
import type {
  ExtensionStatusInfo,
  FailedExtension,
  TurnProjection,
  LoadedExtension,
  RunContext,
  ScheduledJobFailureInfo,
} from "../../domain/extension.js"
import { type PromptSection } from "../../domain/prompt.js"
import type { PermissionRule } from "../../domain/permission.js"
import type { ActionToken } from "../../domain/capability/action.js"
import type { RequestToken } from "../../domain/capability/request.js"
import type { ToolToken } from "../../domain/capability/tool.js"
import {
  compileExtensionReactions,
  type CompiledExtensionReactions,
} from "./extension-reactions.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"
import { sealErasedEffect } from "./effect-membrane.js"

// SlashCommand — public-facing slash entry. Built from `commands:` bucket
// winners. Read- and write-intent both surface as commands; the bucket is the
// load-bearing filter. The legacy server-side command contribution shape died
// in C8.
export interface SlashCommand {
  /** Routing key (capability id, extension-local). */
  readonly name: string
  /** Author-supplied display name for the slash menu / palette. Falls back to
   *  `name` when absent (`tool()` / `request()` capabilities). */
  readonly displayName?: string
  readonly description?: string
  /** Author-supplied palette category. */
  readonly category?: string
  /** Author-supplied keybind hint (display-only). */
  readonly keybind?: string
  readonly extensionId: ExtensionId
  readonly capabilityId: string
  readonly intent: "read" | "write"
}

// Resolved snapshot — the immutable compiled state

export interface ResolvedExtensions {
  readonly modelCapabilities: ReadonlyMap<string, ToolToken>
  readonly rpcRegistry: CompiledRpcRegistry
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
  readonly promptSections: ReadonlyMap<string, PromptSection>
  readonly permissionRules: ReadonlyArray<PermissionRule>
  readonly extensionReactions: CompiledExtensionReactions
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions: ReadonlyArray<FailedExtension>
  readonly extensionStatuses: ReadonlyArray<ExtensionStatusInfo>
}

interface RegisteredToolEntry {
  readonly kind: "tool"
  readonly extensionId: ExtensionId
  readonly capability: ToolToken
}

interface RegisteredCommandEntry {
  readonly kind: "command"
  readonly extensionId: ExtensionId
  readonly capability: ActionToken
}

interface RegisteredRpcEntry {
  readonly kind: "rpc"
  readonly extensionId: ExtensionId
  readonly capability: RequestToken
}

type RegisteredCapabilityEntry = RegisteredToolEntry | RegisteredCommandEntry | RegisteredRpcEntry

const isRequestToken = (cap: ActionToken | RequestToken): cap is RequestToken => "public" in cap

export interface CapabilityRunOptions {
  readonly intent?: "read" | "write"
}

export interface CompiledRpcRegistry {
  readonly run: (
    extensionId: ExtensionId,
    capabilityId: RpcId,
    input: unknown,
    ctx: CapabilityCoreContext,
    options?: CapabilityRunOptions,
  ) => Effect.Effect<unknown, CapabilityError | CapabilityNotFoundError>
}

type ScheduledJobFailureByExtension = ReadonlyMap<string, ReadonlyArray<ScheduledJobFailureInfo>>

/** Compile a keyed bucket from sorted extensions. Later scope wins. */
const compileBucket = <T>(
  sorted: ReadonlyArray<LoadedExtension>,
  pickBucket: (ext: LoadedExtension) => ReadonlyArray<T> | undefined,
  getKey: (item: T) => string,
): Map<string, T> => {
  const result = new Map<string, T>()
  for (const ext of sorted) {
    const items = pickBucket(ext) ?? []
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
    for (const cap of ext.contributions.tools ?? []) {
      winners.set(String(cap.id), { kind: "tool", extensionId: ext.manifest.id, capability: cap })
    }
    for (const cap of ext.contributions.commands ?? []) {
      winners.set(String(cap.id), {
        kind: "command",
        extensionId: ext.manifest.id,
        capability: cap,
      })
    }
    for (const cap of ext.contributions.rpc ?? []) {
      winners.set(String(cap.id), { kind: "rpc", extensionId: ext.manifest.id, capability: cap })
    }
  }
  return winners
}

const compileCapabilityEntries = (
  sorted: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<RegisteredCapabilityEntry> => {
  const entries: RegisteredCapabilityEntry[] = []
  for (const ext of sorted) {
    for (const capability of ext.contributions.tools ?? []) {
      entries.push({ kind: "tool", extensionId: ext.manifest.id, capability })
    }
    for (const capability of ext.contributions.commands ?? []) {
      entries.push({ kind: "command", extensionId: ext.manifest.id, capability })
    }
    for (const capability of ext.contributions.rpc ?? []) {
      entries.push({ kind: "rpc", extensionId: ext.manifest.id, capability })
    }
  }
  return entries
}

const resolveCapabilityEntry = (
  entries: ReadonlyArray<RegisteredCapabilityEntry>,
  extensionId: ExtensionId,
  capabilityId: RpcId | CommandId | string,
): RegisteredCapabilityEntry | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i]
    if (
      candidate !== undefined &&
      candidate.extensionId === extensionId &&
      candidate.capability.id === capabilityId
    ) {
      return candidate
    }
  }
  return undefined
}

const runExtensionCapability = (
  extensionId: ExtensionId,
  capabilityId: RpcId | CommandId | string,
  capability: RequestToken | ActionToken,
  input: unknown,
  ctx: CapabilityCoreContext,
) =>
  Effect.gen(function* () {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- erased schema boundary for heterogeneously typed extension leaves
    const decodedInput = yield* Schema.decodeUnknownEffect(capability.input as Schema.Any)(
      input,
    ).pipe(
      Effect.catchEager((e) =>
        Effect.fail(
          new CapabilityErrorClass({
            extensionId,
            capabilityId,
            reason: `input decode failed: ${String(e)}`,
          }),
        ),
      ),
    )

    const output = yield* sealErasedEffect(
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — explicit membrane entrypoint for existential extension leaf
      () =>
        capability.effect(
          decodedInput,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- leaf registry owns erased ctx boundary
          ctx as Parameters<typeof capability.effect>[1],
        ),
      {
        onFailure: (error) =>
          Schema.is(CapabilityErrorClass)(error)
            ? Effect.fail(error)
            : Effect.fail(
                new CapabilityErrorClass({
                  extensionId,
                  capabilityId,
                  reason: `handler failure: ${String(error)}`,
                }),
              ),
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- erased schema boundary for heterogeneously typed extension leaves
    yield* Schema.encodeUnknownEffect(capability.output as Schema.Any)(output).pipe(
      Effect.catchEager((e) =>
        Effect.fail(
          new CapabilityErrorClass({
            extensionId,
            capabilityId,
            reason: `output validation failed: ${String(e)}`,
          }),
        ),
      ),
    )
    return output
  })

const compileRpcRegistry = (
  entries: ReadonlyArray<RegisteredCapabilityEntry>,
): CompiledRpcRegistry => ({
  run: (extensionId, capabilityId, input, ctx, options) =>
    Effect.gen(function* () {
      const entry = resolveCapabilityEntry(entries, extensionId, capabilityId)
      if (entry === undefined || entry.kind !== "rpc") {
        return yield* new CapabilityNotFoundErrorClass({ extensionId, capabilityId })
      }
      if (options?.intent !== undefined && entry.capability.intent !== options.intent) {
        return yield* new CapabilityErrorClass({
          extensionId,
          capabilityId,
          reason: `intent mismatch: expected ${options.intent}, got ${entry.capability.intent}`,
        })
      }
      return yield* runExtensionCapability(extensionId, capabilityId, entry.capability, input, ctx)
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

const capabilityToCommand = (
  extensionId: ExtensionId,
  cap: ActionToken | RequestToken,
): SlashCommand => {
  // Prefer cap.description (author-supplied, human-readable) over
  // cap.promptSnippet (LLM-prompt fragment) so action() callers don't have
  // to duplicate the same string into both fields.
  const isRequest = isRequestToken(cap)
  const slash = isRequest ? cap.slash : undefined
  const description = slash?.description ?? cap.description ?? cap.promptSnippet
  const displayName = slash?.name ?? (isRequest ? undefined : cap.displayName)
  const category = slash?.category ?? (isRequest ? undefined : cap.category)
  const keybind = slash?.keybind ?? (isRequest ? undefined : cap.keybind)
  return {
    name: String(cap.id),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(keybind !== undefined ? { keybind } : {}),
    extensionId,
    capabilityId: String(cap.id),
    intent: cap.intent,
  }
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
  const modelCapabilities = new Map<string, ToolToken>()
  for (const [id, entry] of capabilityWinners) {
    if (entry.kind !== "tool") continue
    modelCapabilities.set(id, entry.capability)
  }

  const agents = compileBucket(
    sorted,
    (e) => e.contributions.agents,
    (a) => a.name,
  )
  const modelDrivers = compileBucket(
    sorted,
    (e) => e.contributions.modelDrivers,
    (d) => d.id,
  )
  const externalDrivers = compileBucket(
    sorted,
    (e) => e.contributions.externalDrivers,
    (d) => d.id,
  )

  // Prompt sections from capability leaves are read off the WINNERS map,
  // not raw extractions. Otherwise a higher-scope capability shadowing a
  // lower-scope tool would still inherit the loser's prompt — defeating the
  // shadow (codex BLOCKER on C7). Last scope wins by section id, identical
  // to the legacy promptSection contribution semantics.
  // (Dynamic prompt content is assembled per-turn by ExtensionReactions, not here.)
  const promptSectionsMap = new Map<string, PromptSection>()
  for (const { capability: cap } of capabilityWinners.values()) {
    if (cap.prompt) promptSectionsMap.set(cap.prompt.id, cap.prompt)
  }

  // C7: permission rules collected from WINNERS, not raw extractions —
  // otherwise overriding `bash` without `permissionRules` would still inherit
  // builtin denies (codex BLOCKER on C7).
  const permissionRules: PermissionRule[] = []
  for (const { capability: cap } of capabilityWinners.values()) {
    if (cap.permissionRules) permissionRules.push(...cap.permissionRules)
  }

  const extensionReactions = compileExtensionReactions(sorted)
  const extensionStatuses: ExtensionStatusInfo[] = [
    ...sorted.map((ext) => ({
      manifest: ext.manifest,
      scope: ext.scope,
      sourcePath: ext.sourcePath,
      status: "active" as const,
      ...(scheduledJobFailures.has(ext.manifest.id)
        ? { scheduledJobFailures: scheduledJobFailures.get(ext.manifest.id) }
        : {}),
    })),
    ...mergedFailures.map((failure) => ({
      ...failure,
      status: "failed" as const,
      ...(scheduledJobFailures.has(failure.manifest.id)
        ? { scheduledJobFailures: scheduledJobFailures.get(failure.manifest.id) }
        : {}),
    })),
  ]

  return {
    modelCapabilities,
    rpcRegistry,
    agents,
    modelDrivers,
    externalDrivers,
    promptSections: promptSectionsMap,
    permissionRules,
    extensionReactions,
    extensions: sorted,
    failedExtensions: mergedFailures,
    extensionStatuses,
  }
}

// ToolPolicy compiler — unified tool filtering + prompt section collection

export interface CompiledToolPolicy {
  readonly tools: ReadonlyArray<ToolToken>
  readonly promptSections: ReadonlyArray<PromptSection>
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
  allTools: ReadonlyArray<ToolToken>,
  agent: AgentDefinition,
  runContext: RunContext,
  extensionProjections: ReadonlyArray<TurnProjection>,
): CompiledToolPolicy => {
  const allToolsByName = new Map(allTools.map((t) => [String(t.id), t]))

  // 1. Agent allow/deny filtering
  let tools = filterToolsForAgent(allTools, agent)

  // 2. Extension projection fragments (overrideSet is exclusive — include/exclude ignored when set)
  for (const projection of extensionProjections) {
    const policy = projection.toolPolicy
    if (policy === undefined) continue

    if (policy.overrideSet !== undefined) {
      // Replace the full tool list from the known tool universe
      tools = policy.overrideSet.flatMap((name) => {
        const t = allToolsByName.get(name)
        return t !== undefined ? [t] : []
      })
    } else {
      if (policy.include !== undefined) {
        const existing = new Set(tools.map((t) => String(t.id)))
        for (const name of policy.include) {
          if (!existing.has(name)) {
            const t = allToolsByName.get(name)
            if (t !== undefined) {
              tools.push(t)
              existing.add(name)
            }
          }
        }
      }
      if (policy.exclude !== undefined) {
        const excludeSet = new Set(policy.exclude)
        tools = tools.filter((t) => !excludeSet.has(String(t.id)))
      }
    }
  }

  // 4. Re-apply agent deny list — extensions can't escape denials
  tools = applyDenyFilter(tools, agent)

  // 5. Filter interactive tools in non-interactive contexts (headless, subagent)
  if (runContext.interactive === false) {
    tools = tools.filter((t) => t.interactive !== true)
  }

  // 6. Collect extension-contributed prompt sections
  const promptSections: PromptSection[] = []
  for (const projection of extensionProjections) {
    if (projection.promptSections !== undefined) {
      promptSections.push(...projection.promptSections)
    }
  }

  return { tools, promptSections }
}

// Extension Registry Service

export interface ExtensionRegistryService {
  // Model capability resolution
  readonly getModelCapability: (name: string) => Effect.Effect<ToolToken | undefined>
  readonly listModelCapabilities: () => Effect.Effect<ReadonlyArray<ToolToken>>
  /** Resolve tools + prompt sections for an agent turn, applying extension projections. */
  readonly resolveToolPolicy: (
    agent: AgentDefinition,
    runContext: RunContext,
    extensionProjections: ReadonlyArray<TurnProjection>,
  ) => Effect.Effect<CompiledToolPolicy>

  // Agent resolution
  readonly getAgent: (name: string) => Effect.Effect<AgentDefinition | undefined>
  readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>

  /** Resolve primary + reviewer model pair for dual-model workflows.
   *  Tries cowork/deepwork by name, falls back to first two modeled agents, dies if none. */
  readonly resolveDualModelPair: () => Effect.Effect<[ModelId, ModelId]>

  // Permission rules
  readonly listPermissionRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>

  // Prompt sections
  readonly listPromptSections: () => Effect.Effect<ReadonlyArray<PromptSection>>

  // Diagnostics
  readonly listFailedExtensions: () => Effect.Effect<ReadonlyArray<FailedExtension>>
  readonly listExtensionStatuses: () => Effect.Effect<ReadonlyArray<ExtensionStatusInfo>>

  readonly extensionReactions: CompiledExtensionReactions

  // Raw resolved data — needed for rebuilding extension services in child runtimes
  readonly getResolved: () => ResolvedExtensions
}

export class ExtensionRegistry extends Context.Service<
  ExtensionRegistry,
  ExtensionRegistryService
>()("@gent/core/src/runtime/extensions/registry/ExtensionRegistry") {
  static fromResolved = (resolved: ResolvedExtensions): Layer.Layer<ExtensionRegistry> =>
    Layer.succeed(ExtensionRegistry, {
      getModelCapability: (name) => Effect.succeed(resolved.modelCapabilities.get(name)),
      listModelCapabilities: () => Effect.succeed([...resolved.modelCapabilities.values()]),
      resolveToolPolicy: (agent, runContext, extensionProjections) =>
        Effect.succeed(
          compileToolPolicy(
            [...resolved.modelCapabilities.values()],
            agent,
            runContext,
            extensionProjections,
          ),
        ),
      listPermissionRules: () => Effect.succeed(resolved.permissionRules),
      getAgent: (name) => Effect.succeed(resolved.agents.get(name)),
      listAgents: () => Effect.succeed([...resolved.agents.values()]),
      resolveDualModelPair: () =>
        Effect.gen(function* () {
          const agents = [...resolved.agents.values()]
          // 1. Name-based: cowork + deepwork (the standard dual-model pair)
          const cowork = resolved.agents.get("cowork")
          const deepwork = resolved.agents.get("deepwork")
          if (cowork !== undefined && deepwork !== undefined) {
            return [resolveAgentModel(cowork), resolveAgentModel(deepwork)] as [ModelId, ModelId]
          }
          // 3. Position-based fallback: first two modeled agents
          const modeledAgents = agents.filter((agent) => agent.model !== undefined)
          if (modeledAgents.length >= 2) {
            const first = modeledAgents[0]
            const second = modeledAgents[1]
            if (first !== undefined && second !== undefined) {
              return [resolveAgentModel(first), resolveAgentModel(second)] as [ModelId, ModelId]
            }
          }
          if (modeledAgents.length === 1) {
            const only = modeledAgents[0]
            if (only !== undefined) {
              return [resolveAgentModel(only), resolveAgentModel(only)] as [ModelId, ModelId]
            }
          }
          return yield* Effect.die(
            "No modeled agents registered — dual-model workflows require at least one agent with a model",
          )
        }),
      // C7: dynamic prompt sections are assembled per-turn by ExtensionReactions.
      // The sections here come from capability leaf `prompt`, all static. No more
      // per-section Effect resolution — return the array directly.
      listPromptSections: () => Effect.succeed([...resolved.promptSections.values()]),
      listFailedExtensions: () => Effect.succeed(resolved.failedExtensions),
      listExtensionStatuses: () => Effect.succeed(resolved.extensionStatuses),
      extensionReactions: resolved.extensionReactions,
      getResolved: () => resolved,
    })

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
}

export const listSlashCommands = (
  extensions: ReadonlyArray<LoadedExtension>,
  options?: { readonly publicOnly?: boolean },
): ReadonlyArray<SlashCommand> => {
  const winners = new Map<string, RegisteredCapabilityEntry>()
  for (const ext of sortExtensionsByScope(extensions)) {
    for (const cap of ext.contributions.tools ?? []) {
      winners.set(String(cap.id), { kind: "tool", extensionId: ext.manifest.id, capability: cap })
    }
    for (const cap of ext.contributions.commands ?? []) {
      winners.set(String(cap.id), {
        kind: "command",
        extensionId: ext.manifest.id,
        capability: cap,
      })
    }
    for (const cap of ext.contributions.rpc ?? []) {
      winners.set(String(cap.id), { kind: "rpc", extensionId: ext.manifest.id, capability: cap })
    }
  }
  const commands: SlashCommand[] = []
  for (const entry of winners.values()) {
    if (entry.kind !== "command" && entry.kind !== "rpc") continue
    if (entry.kind === "command" && !entry.capability.surface.includes("slash")) continue
    if (entry.kind === "rpc" && entry.capability.slash === undefined) continue
    if (options?.publicOnly === true && entry.kind !== "rpc") continue
    commands.push(capabilityToCommand(entry.extensionId, entry.capability))
  }
  return commands
}

/** Resolve a required agent from the registry. Fails with a clear error if not found. */
export const requireAgent = (name: string) =>
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistry
    const agent = yield* registry.getAgent(name)
    if (agent === undefined) {
      return yield* Effect.die(
        new Error(
          `Required agent "${name}" not found in ExtensionRegistry. Is @gent/agents disabled?`,
        ),
      )
    }
    return agent
  })

// Tool filtering — pure helper for agent tool visibility

const filterToolsForAgent = (
  allTools: ReadonlyArray<ToolToken>,
  agent: AgentDefinition,
): ToolToken[] => {
  let tools: ToolToken[]

  if (agent.allowedTools !== undefined) {
    const names = new Set(agent.allowedTools)
    tools = allTools.filter((t) => names.has(String(t.id)))
  } else {
    tools = [...allTools]
  }

  if (agent.deniedTools !== undefined) {
    tools = applyDenyFilter(tools, agent)
  }

  return tools
}

/** Re-apply deny filter — extensions can't escape agent denials. */
const applyDenyFilter = (tools: ReadonlyArray<ToolToken>, agent: AgentDefinition): ToolToken[] => {
  if (agent.deniedTools === undefined) return [...tools]
  const denied = new Set(agent.deniedTools)
  return tools.filter((t) => !denied.has(String(t.id)))
}
