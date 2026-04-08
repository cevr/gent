import { ServiceMap, Effect, Layer } from "effect"
import { resolveAgentModel, type AgentDefinition } from "../../domain/agent.js"
import type { ModelId } from "../../domain/model.js"
import type {
  CommandContribution,
  ExtensionStatusInfo,
  FailedExtension,
  TurnProjection,
  LoadedExtension,
  ProviderAuthInfo,
  ProviderContribution,
  RunContext,
  ScheduledJobFailureInfo,
} from "../../domain/extension.js"
import {
  isDynamicPromptSection,
  type PromptSection,
  type PromptSectionInput,
} from "../../domain/prompt.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import type { PermissionRule } from "../../domain/permission.js"
import { type CompiledHookMap, compileHooks } from "./hooks.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

// Resolved snapshot — the immutable compiled state

export interface ResolvedExtensions {
  readonly tools: ReadonlyMap<string, AnyToolDefinition>
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly providers: ReadonlyMap<string, ProviderContribution>
  readonly promptSections: ReadonlyMap<string, PromptSectionInput>
  readonly commands: ReadonlyArray<CommandContribution>
  readonly permissionRules: ReadonlyArray<PermissionRule>
  readonly hooks: CompiledHookMap
  readonly extensions: ReadonlyArray<LoadedExtension>
  readonly failedExtensions: ReadonlyArray<FailedExtension>
  readonly extensionStatuses: ReadonlyArray<ExtensionStatusInfo>
}

type ScheduledJobFailureByExtension = ReadonlyMap<string, ReadonlyArray<ScheduledJobFailureInfo>>

/** Compile a keyed contribution from sorted extensions. Later scope wins. */
const compileContributions = <T>(
  sorted: ReadonlyArray<LoadedExtension>,
  extract: (setup: LoadedExtension["setup"]) => ReadonlyArray<T> | undefined,
  getKey: (item: T) => string,
): Map<string, T> => {
  const result = new Map<string, T>()
  for (const ext of sorted) {
    for (const item of extract(ext.setup) ?? []) {
      const key = getKey(item)
      result.set(key, item)
    }
  }
  return result
}

/** Compile prevalidated extensions into an immutable resolved snapshot. */
export const resolveExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  scheduledJobFailures: ScheduledJobFailureByExtension = new Map(),
): ResolvedExtensions => {
  const mergedFailures = [...failedExtensions]
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  const tools = compileContributions(
    sorted,
    (s) => s.tools,
    (t) => t.name,
  )
  const agents = compileContributions(
    sorted,
    (s) => s.agents,
    (a) => a.name,
  )
  const providers = compileContributions(
    sorted,
    (s) => s.providers,
    (p) => p.id,
  )

  // Prompt sections: last scope wins by section id
  const promptSectionsMap = compileContributions(
    sorted,
    (s) => s.promptSections,
    (p) => p.id,
  )

  const commands: CommandContribution[] = []
  const permissionRules: PermissionRule[] = []
  for (const ext of sorted) {
    for (const cmd of ext.setup.commands ?? []) {
      commands.push(cmd)
    }
    for (const rule of ext.setup.permissionRules ?? []) {
      permissionRules.push(rule)
    }
  }

  const hooks = compileHooks(sorted)
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
    tools,
    agents,
    providers,
    promptSections: promptSectionsMap,
    commands,
    permissionRules,
    hooks,
    extensions: sorted,
    failedExtensions: mergedFailures,
    extensionStatuses,
  }
}

// ToolPolicy compiler — unified tool filtering + prompt section collection

export interface CompiledToolPolicy {
  readonly tools: ReadonlyArray<AnyToolDefinition>
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
  allTools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
  runContext: RunContext,
  extensionProjections: ReadonlyArray<TurnProjection>,
): CompiledToolPolicy => {
  const allToolsByName = new Map(allTools.map((t) => [t.name, t]))

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
        const existing = new Set(tools.map((t) => t.name))
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
        tools = tools.filter((t) => !excludeSet.has(t.name))
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
  // Tool resolution
  readonly getTool: (name: string) => Effect.Effect<AnyToolDefinition | undefined>
  readonly listTools: () => Effect.Effect<ReadonlyArray<AnyToolDefinition>>
  /** Resolve tools + prompt sections for an agent turn, applying extension projections. */
  readonly resolveToolPolicy: (
    agent: AgentDefinition,
    runContext: RunContext,
    extensionProjections: ReadonlyArray<TurnProjection>,
  ) => Effect.Effect<CompiledToolPolicy>

  // Command resolution
  readonly listCommands: () => Effect.Effect<ReadonlyArray<CommandContribution>>

  // Agent resolution
  readonly getAgent: (name: string) => Effect.Effect<AgentDefinition | undefined>
  readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>

  // Provider resolution
  readonly getProvider: (id: string) => Effect.Effect<ProviderContribution | undefined>
  readonly listProviders: () => Effect.Effect<ReadonlyArray<ProviderContribution>>
  /** Run base catalog through each provider's listModels filter.
   *  resolveAuth is called per provider to get stored auth info. */
  readonly filterProviderModels: (
    baseCatalog: ReadonlyArray<unknown>,
    resolveAuth?: (providerId: string) => Effect.Effect<ProviderAuthInfo | undefined>,
  ) => Effect.Effect<ReadonlyArray<unknown>>

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

  // Hooks
  readonly hooks: CompiledHookMap

  // Raw resolved data — needed for rebuilding extension services in child runtimes
  readonly getResolved: () => ResolvedExtensions
}

export class ExtensionRegistry extends ServiceMap.Service<
  ExtensionRegistry,
  ExtensionRegistryService
>()("@gent/core/src/runtime/extensions/registry/ExtensionRegistry") {
  static fromResolved = (resolved: ResolvedExtensions): Layer.Layer<ExtensionRegistry> =>
    Layer.succeed(ExtensionRegistry, {
      getTool: (name) => Effect.succeed(resolved.tools.get(name)),
      listTools: () => Effect.succeed([...resolved.tools.values()]),
      resolveToolPolicy: (agent, runContext, extensionProjections) =>
        Effect.succeed(
          compileToolPolicy([...resolved.tools.values()], agent, runContext, extensionProjections),
        ),
      listCommands: () => Effect.succeed(resolved.commands),
      listPermissionRules: () => Effect.succeed(resolved.permissionRules),
      getAgent: (name) => Effect.succeed(resolved.agents.get(name)),
      listAgents: () => Effect.succeed([...resolved.agents.values()]),
      getProvider: (id) => Effect.succeed(resolved.providers.get(id)),
      listProviders: () => Effect.succeed([...resolved.providers.values()]),
      filterProviderModels: (baseCatalog, resolveAuth) =>
        Effect.gen(function* () {
          let catalog = baseCatalog
          for (const provider of resolved.providers.values()) {
            if (provider.listModels !== undefined) {
              const authInfo =
                resolveAuth !== undefined
                  ? yield* resolveAuth(provider.id).pipe(
                      Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))),
                    )
                  : undefined
              catalog = provider.listModels(catalog, authInfo)
            }
          }
          return catalog
        }),
      resolveDualModelPair: () =>
        Effect.gen(function* () {
          const agents = [...resolved.agents.values()]
          // 1. Role-based: find primary + reviewer
          const primary = agents.find((a) => a.role === "primary")
          const reviewer = agents.find((a) => a.role === "reviewer")
          if (primary !== undefined && reviewer !== undefined) {
            return [resolveAgentModel(primary), resolveAgentModel(reviewer)] as [ModelId, ModelId]
          }
          // 2. Name-based fallback: cowork + deepwork
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
      listPromptSections: () =>
        Effect.forEach([...resolved.promptSections.values()], (section) =>
          isDynamicPromptSection(section)
            ? Effect.map(section.resolve, (content) => ({
                id: section.id,
                content,
                priority: section.priority,
              }))
            : Effect.succeed(section),
        ),
      listFailedExtensions: () => Effect.succeed(resolved.failedExtensions),
      listExtensionStatuses: () => Effect.succeed(resolved.extensionStatuses),
      hooks: resolved.hooks,
      getResolved: () => resolved,
    })

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
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
  allTools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
): AnyToolDefinition[] => {
  let tools: AnyToolDefinition[]

  if (agent.allowedTools !== undefined) {
    const names = new Set(agent.allowedTools)
    tools = allTools.filter((t) => names.has(t.name))
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
  tools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
): AnyToolDefinition[] => {
  if (agent.deniedTools === undefined) return [...tools]
  const denied = new Set(agent.deniedTools)
  return tools.filter((t) => !denied.has(t.name))
}
