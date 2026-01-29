import type { AgentDefinition } from "@gent/core"

export const buildSystemPrompt = (
  basePrompt: string,
  agent: AgentDefinition,
  contextPrefix?: string,
): string => {
  const parts: string[] = []
  if (contextPrefix !== undefined && contextPrefix !== "") parts.push(contextPrefix)
  parts.push(basePrompt)

  if (agent.systemPromptAddendum !== undefined && agent.systemPromptAddendum !== "") {
    parts.push(`\n\n## Agent: ${agent.name}\n${agent.systemPromptAddendum}`)
  }

  return parts.join("")
}
