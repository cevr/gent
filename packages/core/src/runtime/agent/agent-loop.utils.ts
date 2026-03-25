import type { AgentDefinition } from "../../domain/agent.js"
import {
  type ReasoningPart,
  type Message,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
} from "../../domain/message.js"
import type { MessageId } from "../../domain/ids.js"
import type { ProviderRequest } from "../../providers/provider.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import { compileSystemPrompt, type PromptSection } from "../../server/system-prompt.js"
import type { AssistantDraft } from "./agent-loop.state.js"

const VALID_REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

/**
 * Build a per-turn system prompt from base sections, agent addendum, and active tools.
 *
 * Tools with `promptSnippet` appear in a tool list; tools with `promptGuidelines`
 * contribute behavioral bullets. This replaces the old static `# Tools` section
 * with dynamic, tool-aware content.
 */
export const buildTurnPrompt = (
  baseSections: ReadonlyArray<PromptSection>,
  agent: AgentDefinition,
  tools: ReadonlyArray<AnyToolDefinition>,
  extraSections?: ReadonlyArray<PromptSection>,
): string => {
  const sections: PromptSection[] = [...baseSections]

  // Agent addendum
  if (agent.systemPromptAddendum !== undefined && agent.systemPromptAddendum !== "") {
    sections.push({
      id: "agent-addendum",
      content: `## Agent: ${agent.name}\n${agent.systemPromptAddendum}`,
      priority: 90,
    })
  }

  // Tool list — tools with promptSnippet get listed explicitly
  const snippets = tools
    .filter((t) => t.promptSnippet !== undefined)
    .map((t) => `- **${t.name}**: ${t.promptSnippet}`)
  if (snippets.length > 0) {
    sections.push({
      id: "tool-list",
      content: `## Available Tools\n\n${snippets.join("\n")}`,
      priority: 42,
    })
  }

  // Tool guidelines — collected from active tools + conditional rules
  const guidelines = tools.flatMap((t) => t.promptGuidelines ?? [])
  const hasBash = tools.some((t) => t.name === "bash")
  const hasDedicatedSearch = tools.some(
    (t) => t.name === "grep" || t.name === "glob" || t.name === "read",
  )
  if (hasBash && hasDedicatedSearch) {
    guidelines.push("Prefer grep/glob/read tools over bash for file searching and reading")
  }
  if (guidelines.length > 0) {
    const deduped = [...new Set(guidelines)]
    sections.push({
      id: "tool-guidelines",
      content: `## Tool Guidelines\n\n${deduped.map((g) => `- ${g}`).join("\n")}`,
      priority: 44,
    })
  }

  // Extension-contributed sections
  if (extraSections !== undefined) {
    for (const s of extraSections) {
      sections.push(s)
    }
  }

  return compileSystemPrompt(sections)
}

export const resolveReasoning = (
  agent: AgentDefinition,
  sessionOverride?: string,
): ProviderRequest["reasoning"] | undefined => {
  if (sessionOverride !== undefined && VALID_REASONING_LEVELS.has(sessionOverride)) {
    return sessionOverride as ProviderRequest["reasoning"]
  }
  return agent.reasoningEffort
}

export const getSingleText = (message: Message): string | undefined => {
  if (message.parts.length !== 1) return undefined
  const [part] = message.parts
  return part?.type === "text" ? part.text : undefined
}

export const messageText = (message: Message): string =>
  message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

export const assistantMessageIdForTurn = (messageId: MessageId): MessageId =>
  `${messageId}:assistant` as MessageId

export const toolResultMessageIdForTurn = (messageId: MessageId): MessageId =>
  `${messageId}:tool-result` as MessageId

export const assistantDraftFromMessage = (message: Message): AssistantDraft => ({
  text: message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join(""),
  reasoning: message.parts
    .filter((part): part is ReasoningPart => part.type === "reasoning")
    .map((part) => part.text)
    .join(""),
  toolCalls: message.parts.filter((part): part is ToolCallPart => part.type === "tool-call"),
})

export const toolResultsFromMessage = (message: Message): ReadonlyArray<ToolResultPart> =>
  message.parts.filter((part): part is ToolResultPart => part.type === "tool-result")
