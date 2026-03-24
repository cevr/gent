import { ServiceMap, Effect, Layer } from "effect"
import type { AgentDefinition } from "../../domain/agent.js"
import type {
  ExtensionKind,
  ExtensionProjection,
  LoadedExtension,
  RunContext,
  SystemPromptFragment,
  TagInjection,
} from "../../domain/extension.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import { type CompiledHookMap, compileHooks } from "./hooks.js"

// Scope precedence: project > user > builtin
// Later scope wins for same-name tools/agents.

const SCOPE_PRECEDENCE: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

// Resolved snapshot — the immutable compiled state

export interface ResolvedExtensions {
  readonly tools: ReadonlyMap<string, AnyToolDefinition>
  readonly agents: ReadonlyMap<string, AgentDefinition>
  readonly promptFragments: ReadonlyArray<SystemPromptFragment>
  readonly tagInjections: ReadonlyArray<TagInjection>
  readonly hooks: CompiledHookMap
  readonly extensions: ReadonlyArray<LoadedExtension>
}

/** Compile loaded extensions into an immutable resolved snapshot. Throws on same-scope collisions. */
export const resolveExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ResolvedExtensions => {
  // Sort by scope precedence (builtin first, project last)
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  // Tools: later scope wins for same name; reject same-scope collisions
  const tools = new Map<string, AnyToolDefinition>()
  const toolScopes = new Map<string, { kind: ExtensionKind; extId: string }>()
  for (const ext of sorted) {
    for (const tool of ext.setup.tools ?? []) {
      const prev = toolScopes.get(tool.name)
      if (prev !== undefined && prev.kind === ext.kind && prev.extId !== ext.manifest.id) {
        throw new Error(
          `Same-scope tool collision: "${tool.name}" provided by both "${prev.extId}" and "${ext.manifest.id}" in scope "${ext.kind}"`,
        )
      }
      tools.set(tool.name, tool)
      toolScopes.set(tool.name, { kind: ext.kind, extId: ext.manifest.id })
    }
  }

  // Agents: later scope wins for same name; reject same-scope collisions
  const agents = new Map<string, AgentDefinition>()
  const agentScopes = new Map<string, { kind: ExtensionKind; extId: string }>()
  for (const ext of sorted) {
    for (const agent of ext.setup.agents ?? []) {
      const prev = agentScopes.get(agent.name)
      if (prev !== undefined && prev.kind === ext.kind && prev.extId !== ext.manifest.id) {
        throw new Error(
          `Same-scope agent collision: "${agent.name}" provided by both "${prev.extId}" and "${ext.manifest.id}" in scope "${ext.kind}"`,
        )
      }
      agents.set(agent.name, agent)
      agentScopes.set(agent.name, { kind: ext.kind, extId: ext.manifest.id })
    }
  }

  // Prompt fragments: collect all, sorted by priority (lower first)
  const promptFragments: SystemPromptFragment[] = []
  for (const ext of sorted) {
    for (const frag of ext.setup.promptFragments ?? []) {
      promptFragments.push(frag)
    }
  }
  promptFragments.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))

  // Tag injections: collect from all extensions
  const tagInjections: TagInjection[] = []
  for (const ext of sorted) {
    for (const injection of ext.setup.tagInjections ?? []) {
      tagInjections.push(injection)
    }
  }

  const hooks = compileHooks(sorted)

  return { tools, agents, promptFragments, tagInjections, hooks, extensions: sorted }
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
 * 2. Tag-conditional injection (declarative replacement for tools.visible interceptor)
 * 3. Extension projection fragments (include/exclude/overrideSet)
 * 4. Re-apply agent deny list (extensions can't escape denials)
 * 5. Collect extension-contributed prompt sections
 */
export const compileToolPolicy = (
  allTools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
  runContext: RunContext,
  tagInjections: ReadonlyArray<TagInjection>,
  extensionProjections: ReadonlyArray<ExtensionProjection>,
): CompiledToolPolicy => {
  // Build the tool universe — includes base tools plus any tag-injected tools
  const allToolsByName = new Map(allTools.map((t) => [t.name, t]))

  // 1. Agent allow/deny filtering
  let tools = filterToolsForAgent(allTools, agent)

  // 2. Tag-conditional injection
  const tags = runContext.tags
  if (tags !== undefined && tags.length > 0) {
    const tagSet = new Set(tags)
    const existing = new Set(tools.map((t) => t.name))
    for (const injection of tagInjections) {
      if (tagSet.has(injection.tag)) {
        for (const tool of injection.tools) {
          if (!existing.has(tool.name)) {
            tools.push(tool)
            existing.add(tool.name)
          }
          // Expand the universe so projections can reference injected tools
          if (!allToolsByName.has(tool.name)) {
            allToolsByName.set(tool.name, tool)
          }
        }
      }
    }
  }

  // 3. Extension projection fragments (overrideSet is exclusive — include/exclude ignored when set)
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

  // 5. Collect extension-contributed prompt sections
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
  /** Resolve tools + prompt sections for an agent turn, applying tag injections and extension projections. */
  readonly resolveToolPolicy: (
    agent: AgentDefinition,
    runContext: RunContext,
    extensionProjections: ReadonlyArray<ExtensionProjection>,
  ) => Effect.Effect<CompiledToolPolicy>

  // Agent resolution
  readonly getAgent: (name: string) => Effect.Effect<AgentDefinition | undefined>
  readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listPrimaryAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listSubagents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>

  // Prompt fragments
  readonly getPromptFragments: () => Effect.Effect<ReadonlyArray<SystemPromptFragment>>

  // Hooks
  readonly hooks: CompiledHookMap
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
          compileToolPolicy(
            [...resolved.tools.values()],
            agent,
            runContext,
            resolved.tagInjections,
            extensionProjections,
          ),
        ),
      getAgent: (name) => Effect.succeed(resolved.agents.get(name)),
      listAgents: () => Effect.succeed([...resolved.agents.values()]),
      listPrimaryAgents: () =>
        Effect.succeed(
          [...resolved.agents.values()].filter((a) => a.kind === "primary" && a.hidden !== true),
        ),
      listSubagents: () =>
        Effect.succeed([...resolved.agents.values()].filter((a) => a.kind === "subagent")),
      getPromptFragments: () => Effect.succeed(resolved.promptFragments),
      hooks: resolved.hooks,
    })

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions(extensions))

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
}

// Tool filtering — pure helper for agent tool visibility

const filterToolsForAgent = (
  allTools: ReadonlyArray<AnyToolDefinition>,
  agent: AgentDefinition,
): AnyToolDefinition[] => {
  const hasAllowList = agent.allowedActions !== undefined || agent.allowedTools !== undefined

  let tools: AnyToolDefinition[] = hasAllowList ? [] : [...allTools]

  if (hasAllowList) {
    const actions = agent.allowedActions !== undefined ? new Set(agent.allowedActions) : undefined
    const names = agent.allowedTools !== undefined ? new Set(agent.allowedTools) : undefined
    const included = new Set<string>()

    for (const t of allTools) {
      const byAction = actions !== undefined && actions.has(t.action)
      const byName = names !== undefined && names.has(t.name)
      if ((byAction || byName) && !included.has(t.name)) {
        tools.push(t)
        included.add(t.name)
      }
    }
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
