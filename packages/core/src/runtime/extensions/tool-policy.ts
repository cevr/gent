/**
 * The tool policy one turn runs with.
 *
 * Pure: it takes the resolved capabilities, the agent definition and the
 * turn's projections, and answers which tools the model sees, which tools the
 * host may run, and what prompt sections the projections contribute. Nothing
 * here reaches a service, a layer or the filesystem — the registry resolves
 * the extensions, this compiles the policy they imply.
 *
 * @module
 */

import { Option, Predicate } from "effect"
import type { AgentDefinition } from "../../domain/agent.js"
import type { TurnProjection } from "../../domain/extension.js"
import {
  getToolId,
  getToolMetadata,
  type PromptSection,
  type ToolCapability,
} from "../../domain/capability.js"

interface CompiledToolPolicy {
  readonly tools: ReadonlyArray<ToolCapability>
  readonly modelTools: ReadonlyArray<ToolCapability>
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
  turn: { readonly interactive?: boolean },
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
  if (turn.interactive === false) {
    tools = tools.filter((t) => getToolMetadata(t).interactive !== true)
  }

  let modelSet = Option.none<ReadonlyArray<string>>()
  for (const projection of extensionProjections) {
    if (Predicate.isNotUndefined(projection.toolPolicy?.modelSet)) {
      modelSet = Option.some(projection.toolPolicy.modelSet)
    }
  }
  const modelTools = Option.match(modelSet, {
    onNone: () => tools,
    onSome: (names) => {
      const selected = new Set(names)
      return tools.filter((tool) => selected.has(String(getToolId(tool))))
    },
  })
  return {
    tools,
    modelTools,
    promptSections: collectProjectionPromptSections(extensionProjections),
  }
}

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
