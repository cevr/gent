import { Context, Effect, Layer } from "effect"
import { resolveAgentModel, type AgentDefinition } from "../../domain/agent.js"
import type { ExternalDriverContribution, ModelDriverContribution } from "../../domain/driver.js"
import type { ModelId } from "../../domain/model.js"
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
import { type AnyCapabilityContribution } from "../../domain/capability.js"
import { compileRuntimeSlots, type CompiledRuntimeSlots } from "./runtime-slots.js"
import { compileProjections, type CompiledProjections } from "./projection-registry.js"
import { compileCapabilities, type CompiledCapabilities } from "./capability-host.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

// SlashCommand — public-facing slash entry. Built from `Capability` winners
// whose `audiences.includes("human-slash")`. Read- and write-intent both
// surface as commands; the audience is the load-bearing filter. The legacy
// server-side `CommandContribution` shape died in C8.
export interface SlashCommand {
  readonly name: string
  readonly description?: string
  readonly extensionId: string
  readonly capabilityId: string
  readonly intent: "read" | "write"
}

// Resolved snapshot — the immutable compiled state

export interface ResolvedExtensions {
  readonly modelCapabilities: ReadonlyMap<string, AnyCapabilityContribution>
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
  readonly promptSections: ReadonlyMap<string, PromptSection>
  readonly permissionRules: ReadonlyArray<PermissionRule>
  readonly runtimeSlots: CompiledRuntimeSlots
  readonly projections: CompiledProjections
  readonly capabilities: CompiledCapabilities
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions: ReadonlyArray<FailedExtension>
  readonly extensionStatuses: ReadonlyArray<ExtensionStatusInfo>
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
): ReadonlyMap<string, AnyCapabilityContribution> => {
  const winners = new Map<string, AnyCapabilityContribution>()
  for (const ext of sorted) {
    for (const cap of ext.contributions.capabilities ?? []) {
      winners.set(cap.id, cap)
    }
  }
  return winners
}

const sortExtensionsByScope = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

const capabilityToCommand = (
  extensionId: string,
  cap: AnyCapabilityContribution,
): SlashCommand => ({
  name: cap.id,
  ...(cap.promptSnippet !== undefined ? { description: cap.promptSnippet } : {}),
  extensionId,
  capabilityId: cap.id,
  intent: cap.intent,
})

/** Compile prevalidated extensions into an immutable resolved snapshot. */
export const resolveExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  scheduledJobFailures: ScheduledJobFailureByExtension = new Map(),
): ResolvedExtensions => {
  const mergedFailures = [...failedExtensions]
  const sorted = sortExtensionsByScope(extensions)

  // Tool resolution — identity-first scope shadowing followed by audience
  // authorization. Tools' identity is `cap.id` (flat). Every capability
  // (regardless of audience) enters the candidate map; authorization
  // (`audiences.includes("model")`) happens AFTER selection so a higher-scope
  // override that narrows audiences correctly hides a shadowed builtin tool.
  const capabilityWinners = compileCapabilityWinners(sorted)
  const modelCapabilities = new Map<string, AnyCapabilityContribution>()
  for (const [id, cap] of capabilityWinners) {
    if (!cap.audiences.includes("model")) continue
    modelCapabilities.set(id, cap)
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

  // Prompt sections from `Capability.prompt` are read off the WINNERS map,
  // not raw extractions. Otherwise a higher-scope capability shadowing a
  // lower-scope tool would still inherit the loser's prompt — defeating the
  // shadow (codex BLOCKER on C7). Last scope wins by section id, identical
  // to the legacy promptSection contribution semantics.
  // (Dynamic prompt content lives on `Projection.prompt(value)` and is
  // assembled per-turn by ProjectionRegistry, not here.)
  const promptSectionsMap = new Map<string, PromptSection>()
  for (const cap of capabilityWinners.values()) {
    if (cap.prompt) promptSectionsMap.set(cap.prompt.id, cap.prompt)
  }

  // C7: permission rules collected from WINNERS, not raw extractions —
  // otherwise overriding `bash` without `permissionRules` would still inherit
  // builtin denies (codex BLOCKER on C7).
  const permissionRules: PermissionRule[] = []
  for (const cap of capabilityWinners.values()) {
    if (cap.permissionRules) permissionRules.push(...cap.permissionRules)
  }

  const runtimeSlots = compileRuntimeSlots(sorted)
  const projections = compileProjections(sorted)
  const capabilities = compileCapabilities(sorted)
  const extensionStatuses: ExtensionStatusInfo[] = [
    ...sorted.map((ext) => ({
      manifest: ext.manifest,
      kind: ext.kind,
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
    agents,
    modelDrivers,
    externalDrivers,
    promptSections: promptSectionsMap,
    permissionRules,
    runtimeSlots,
    projections,
    capabilities,
    extensions: sorted,
    failedExtensions: mergedFailures,
    extensionStatuses,
  }
}

// ToolPolicy compiler — unified tool filtering + prompt section collection

export interface CompiledToolPolicy {
  readonly tools: ReadonlyArray<AnyCapabilityContribution>
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
  allTools: ReadonlyArray<AnyCapabilityContribution>,
  agent: AgentDefinition,
  runContext: RunContext,
  extensionProjections: ReadonlyArray<TurnProjection>,
): CompiledToolPolicy => {
  const allToolsByName = new Map(allTools.map((t) => [t.id, t]))

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
        const existing = new Set(tools.map((t) => t.id))
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
        tools = tools.filter((t) => !excludeSet.has(t.id))
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
  readonly getModelCapability: (
    name: string,
  ) => Effect.Effect<AnyCapabilityContribution | undefined>
  readonly listModelCapabilities: () => Effect.Effect<ReadonlyArray<AnyCapabilityContribution>>
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

  readonly runtimeSlots: CompiledRuntimeSlots

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
      // C7: dynamic prompt sections live on `Projection.prompt(value)`. The
      // sections here come from `Capability.prompt`, all static. No more
      // per-section Effect resolution — return the array directly.
      listPromptSections: () => Effect.succeed([...resolved.promptSections.values()]),
      listFailedExtensions: () => Effect.succeed(resolved.failedExtensions),
      listExtensionStatuses: () => Effect.succeed(resolved.extensionStatuses),
      runtimeSlots: resolved.runtimeSlots,
      getResolved: () => resolved,
    })

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
}

export const listSlashCommands = (
  extensions: ReadonlyArray<LoadedExtension>,
  options?: { readonly publicOnly?: boolean },
): ReadonlyArray<SlashCommand> => {
  const winners = new Map<
    string,
    { readonly extensionId: string; readonly cap: AnyCapabilityContribution }
  >()
  for (const ext of sortExtensionsByScope(extensions)) {
    for (const cap of ext.contributions.capabilities ?? []) {
      winners.set(cap.id, { extensionId: ext.manifest.id, cap })
    }
  }
  const commands: SlashCommand[] = []
  for (const { extensionId, cap } of winners.values()) {
    if (!cap.audiences.includes("human-slash")) continue
    if (options?.publicOnly === true && !cap.audiences.includes("transport-public")) continue
    commands.push(capabilityToCommand(extensionId, cap))
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
  allTools: ReadonlyArray<AnyCapabilityContribution>,
  agent: AgentDefinition,
): AnyCapabilityContribution[] => {
  let tools: AnyCapabilityContribution[]

  if (agent.allowedTools !== undefined) {
    const names = new Set(agent.allowedTools)
    tools = allTools.filter((t) => names.has(t.id))
  } else {
    tools = [...allTools]
  }

  if (agent.deniedTools !== undefined) {
    tools = applyDenyFilter(tools, agent)
  }

  return tools
}

/** Re-apply deny filter — extensions can't escape agent denials. */
const applyDenyFilter = (
  tools: ReadonlyArray<AnyCapabilityContribution>,
  agent: AgentDefinition,
): AnyCapabilityContribution[] => {
  if (agent.deniedTools === undefined) return [...tools]
  const denied = new Set(agent.deniedTools)
  return tools.filter((t) => !denied.has(t.id))
}
