import { ReasoningEffort } from "../../domain/agent.js"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type { AgentDefinition, ReasoningEffort as ReasoningEffortType } from "../../domain/agent.js"
import { getToolId, getToolMetadata, type ToolCapability } from "../../domain/capability/tool.js"
import type { Message } from "../../domain/message.js"
import {
  messagePartsReasoning,
  messagePartsText,
  messagePartsTextLines,
  messagePartsToolCallParts,
  messagePartsToolResultParts,
  messageSingleText,
} from "../../domain/message-part-projection.js"
import { type ActorCommandId, MessageId, ToolCallId } from "../../domain/ids.js"
import { Schema } from "effect"
import { compileSystemPrompt, withSectionMarkers, type PromptSection } from "../../domain/prompt.js"
import type { AssistantDraft } from "./agent-loop.state.js"

const isReasoningEffort = Schema.is(ReasoningEffort)

/**
 * Build the per-turn prompt sections (base + agent addendum + tool list +
 * tool guidelines + delegation targets + extension extras). Returns the
 * unsorted section list so prompt slots can rewrite specific sections
 * (e.g. codemode replacing `tool-list` / `tool-guidelines`) before final
 * compilation.
 */
export const buildTurnPromptSections = (
  baseSections: ReadonlyArray<PromptSection>,
  agent: AgentDefinition,
  tools: ReadonlyArray<ToolCapability>,
  extraSections?: ReadonlyArray<PromptSection>,
  delegationTargets?: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<PromptSection> => {
  const sections: PromptSection[] = [...baseSections]

  // Agent addendum
  if (agent.systemPromptAddendum !== undefined && agent.systemPromptAddendum !== "") {
    sections.push({
      id: "agent-addendum",
      content: `## Agent: ${agent.name}\n${agent.systemPromptAddendum}`,
      priority: 90,
    })
  }

  const toolsWithMetadata = tools.map((tool) => ({
    id: getToolId(tool),
    metadata: getToolMetadata(tool),
  }))

  // Tool list — tools with promptSnippet get listed explicitly
  const snippets = toolsWithMetadata
    .filter((tool) => tool.metadata.promptSnippet !== undefined)
    .map((tool) => `- **${tool.id}**: ${tool.metadata.promptSnippet}`)
  if (snippets.length > 0) {
    // Wrap with section sentinels so the ACP codemode prompt slot can swap
    // this block atomically. Other sections don't need markers because
    // nothing downstream rewrites them — markers cost tokens, only spend
    // them where a slot needs the anchor.
    sections.push({
      id: "tool-list",
      content: withSectionMarkers("tool-list", `## Available Tools\n\n${snippets.join("\n")}`),
      priority: 42,
    })
  }

  // Tool guidelines — collected from active tools + conditional rules
  const guidelines = toolsWithMetadata.flatMap((tool) => tool.metadata.promptGuidelines ?? [])
  const hasBash = toolsWithMetadata.some((tool) => tool.id === "bash")
  const dedicatedNames = ["grep", "glob", "read"].filter((name) =>
    toolsWithMetadata.some((tool) => tool.id === name),
  )
  if (hasBash && dedicatedNames.length > 0) {
    guidelines.push(`Prefer ${dedicatedNames.join("/")} over bash for file searching and reading`)
  }
  if (guidelines.length > 0) {
    const deduped = [...new Set(guidelines)]
    sections.push({
      id: "tool-guidelines",
      content: withSectionMarkers(
        "tool-guidelines",
        `## Tool Guidelines\n\n${deduped.map((g) => `- ${g}`).join("\n")}`,
      ),
      priority: 44,
    })
  }

  // Delegation targets — synthesized from registered agents when delegate is available
  // Internal agents are hidden — only user-facing agents appear as delegation targets
  const INTERNAL_AGENTS = new Set(["auditor", "architect", "summarizer", "title", "librarian"])
  const hasDelegate = toolsWithMetadata.some((tool) => tool.id === "delegate")
  if (hasDelegate && delegationTargets !== undefined && delegationTargets.length > 0) {
    const targets = delegationTargets
      .filter(
        (a) => a.name !== agent.name && a.description !== undefined && !INTERNAL_AGENTS.has(a.name),
      )
      .map((a) => `- **${a.name}**: ${a.description}`)
    if (targets.length > 0) {
      sections.push({
        id: "delegation-targets",
        content: `## Delegation Targets\n\nAgents available via the \`delegate\` tool:\n\n${targets.join("\n")}`,
        priority: 46,
      })
    }
  }

  // Extension-contributed sections
  if (extraSections !== undefined) {
    for (const s of extraSections) {
      sections.push(s)
    }
  }

  return sections
}

/**
 * Build a per-turn system prompt from base sections, agent addendum, and
 * active tools. Wraps `buildTurnPromptSections` for callers that don't
 * need the structured intermediate form.
 */
export const buildTurnPrompt = (
  baseSections: ReadonlyArray<PromptSection>,
  agent: AgentDefinition,
  tools: ReadonlyArray<ToolCapability>,
  extraSections?: ReadonlyArray<PromptSection>,
  delegationTargets?: ReadonlyArray<AgentDefinition>,
): string =>
  compileSystemPrompt(
    buildTurnPromptSections(baseSections, agent, tools, extraSections, delegationTargets),
  )

export const resolveReasoning = (
  agent: AgentDefinition,
  sessionOverride?: string,
): ReasoningEffortType | undefined => {
  if (sessionOverride !== undefined && isReasoningEffort(sessionOverride)) {
    return sessionOverride
  }
  return agent.reasoningEffort
}

export const getSingleText = (message: Message): string | undefined =>
  messageSingleText(message.parts)

export const messageText = (message: Message): string =>
  messagePartsTextLines(message.parts).join("\n")

export const assistantMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:assistant:${step}`)

export const toolResultMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:tool-result:${step}`)

export const toolCallIdForCommand = (commandId: ActorCommandId) => ToolCallId.make(commandId)

export const assistantMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:assistant`)

export const toolResultMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:tool-result`)

export const interjectionMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:interjection`)

export const toolResultMessageIdForToolCall = (toolCallId: ToolCallId) =>
  MessageId.make(`tool-call:${toolCallId}:tool-result`)

export const assistantDraftFromMessage = (message: Message): AssistantDraft => ({
  text: messagePartsText(message.parts),
  reasoning: messagePartsReasoning(message.parts),
  toolCalls: messagePartsToolCallParts(message.parts),
})

export const toolResultsFromMessage = (message: Message): ReadonlyArray<Prompt.ToolResultPart> =>
  messagePartsToolResultParts(message.parts)
