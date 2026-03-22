/* eslint-disable @typescript-eslint/no-explicit-any */
import { ServiceMap, Effect, Layer } from "effect"
import type { AgentDefinition } from "../../domain/agent.js"
import type {
  ExtensionKind,
  LoadedExtension,
  RunContext,
  SystemPromptFragment,
} from "../../domain/extension.js"
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
  readonly hooks: CompiledHookMap
  readonly extensions: ReadonlyArray<LoadedExtension>
}

/** Compile loaded extensions into an immutable resolved snapshot. */
export const resolveExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ResolvedExtensions => {
  // Sort by scope precedence (builtin first, project last)
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  // Tools: later scope wins for same name
  const tools = new Map<string, AnyToolDefinition>()
  for (const ext of sorted) {
    for (const tool of ext.setup.tools ?? []) {
      tools.set(tool.name, tool)
    }
  }

  // Agents: later scope wins for same name
  const agents = new Map<string, AgentDefinition>()
  for (const ext of sorted) {
    for (const agent of ext.setup.agents ?? []) {
      agents.set(agent.name, agent)
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

  const hooks = compileHooks(sorted)

  return { tools, agents, promptFragments, hooks, extensions: sorted }
}

// Extension Registry Service

export interface ExtensionRegistryService {
  // Tool resolution
  readonly getTool: (name: string) => Effect.Effect<AnyToolDefinition | undefined>
  readonly listTools: () => Effect.Effect<ReadonlyArray<AnyToolDefinition>>
  /** List tools visible to an agent in a given run context, running the tools.visible interceptor. */
  readonly listToolsForAgent: (
    agent: AgentDefinition,
    runContext: RunContext,
  ) => Effect.Effect<ReadonlyArray<AnyToolDefinition>>

  // Agent resolution
  readonly getAgent: (name: string) => Effect.Effect<AgentDefinition | undefined>
  readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listPrimaryAgents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listSubagents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>

  // Prompt fragments
  readonly getPromptFragments: () => Effect.Effect<ReadonlyArray<SystemPromptFragment>>

  // Hooks
  readonly hooks: CompiledHookMap

  // Register a tool at runtime (compat for additionalTools pattern during migration)
  readonly registerTool: (tool: AnyToolDefinition) => Effect.Effect<void>
}

export class ExtensionRegistry extends ServiceMap.Service<
  ExtensionRegistry,
  ExtensionRegistryService
>()("@gent/core/runtime/extensions/ExtensionRegistry") {
  static fromResolved = (resolved: ResolvedExtensions): Layer.Layer<ExtensionRegistry> =>
    Layer.succeed(ExtensionRegistry, {
      getTool: (name) => Effect.succeed(resolved.tools.get(name)),
      listTools: () => Effect.succeed([...resolved.tools.values()]),
      listToolsForAgent: (agent, runContext) =>
        resolved.hooks.runInterceptor(
          "tools.visible",
          { agent, tools: filterToolsForAgent([...resolved.tools.values()], agent), runContext },
          (input: any) => Effect.succeed(input.tools),
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
      registerTool: (tool) =>
        Effect.sync(() => {
          ;(resolved.tools as Map<string, AnyToolDefinition>).set(tool.name, tool)
        }),
    })

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions(extensions))

  static Test = (): Layer.Layer<ExtensionRegistry> =>
    ExtensionRegistry.fromResolved(resolveExtensions([]))
}

// Tool filtering — mirrors existing filterTools logic from agent-loop.ts

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
    const denied = new Set(agent.deniedTools)
    tools = tools.filter((t) => !denied.has(t.name))
  }

  return tools
}
