import { ReasoningEffort } from "../../domain/agent.js"
import type { AgentDefinition, ReasoningEffort as ReasoningEffortType } from "../../domain/agent.js"
import { getToolId, getToolMetadata, type ToolCapability } from "../../domain/capability/tool.js"
import type { Message } from "../../domain/message.js"
import {
  messagePartsReasoning,
  messagePartsText,
  messagePartsTextLines,
  messagePartsToolCallParts,
  messageSingleText,
} from "../../domain/message-part-projection.js"
import { type ActorCommandId, MessageId, ToolCallId } from "../../domain/ids.js"
import { Option, Predicate, Schema } from "effect"
import { compileSystemPrompt, withSectionMarkers, type PromptSection } from "../../domain/prompt.js"
import type { AssistantDraft } from "./agent-loop.state.js"

const isReasoningEffort = Schema.is(ReasoningEffort)

/**
 * Build the per-turn prompt sections (base + agent addendum + tool list +
 * tool guidelines + cell catalog + extension extras). Returns the
 * unsorted section list so prompt slots can rewrite specific sections
 * (e.g. codemode replacing `tool-list` / `tool-guidelines`) before final
 * compilation.
 */
export const buildTurnPromptSections = (
  baseSections: ReadonlyArray<PromptSection>,
  agent: AgentDefinition,
  tools: ReadonlyArray<ToolCapability>,
  extraSections?: ReadonlyArray<PromptSection>,
  cellHostTools: ReadonlyArray<ToolCapability> = [],
): ReadonlyArray<PromptSection> => {
  const sections: PromptSection[] = [...baseSections]

  // Agent addendum
  if (!Predicate.isUndefined(agent.systemPromptAddendum) && agent.systemPromptAddendum !== "") {
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
    .filter((tool) => !Predicate.isUndefined(tool.metadata.promptSnippet))
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

  // Cell catalog — host tools callable only inside the cell. The system prompt is the
  // instruction delivery: it is rebuilt each turn, so live composition changes reach the
  // model without a catalog tool. Full schemas stay in the kernel behind tools.describe.
  const hostEntries = cellHostTools
    .map((tool) => ({ id: getToolId(tool), metadata: getToolMetadata(tool), tool }))
    .filter((entry) => entry.id !== "cell")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => `- **${entry.id}**: ${entry.metadata.promptSnippet ?? entry.tool.description}`)
  if (hostEntries.length > 0) {
    sections.push({
      id: "cell-catalog",
      content: withSectionMarkers(
        "cell-catalog",
        `## Host Tools\n\nCallable inside \`cell\` with \`await tools.call(name, input)\`. \`tools.describe(name)\` returns the input schema.\n\n${hostEntries.join("\n")}`,
      ),
      priority: 43,
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

  // Extension-contributed sections
  if (!Predicate.isUndefined(extraSections)) {
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
): string => compileSystemPrompt(buildTurnPromptSections(baseSections, agent, tools, extraSections))

export const resolveReasoning = (
  agent: AgentDefinition,
  sessionOverride?: string,
): Option.Option<ReasoningEffortType> => {
  if (!Predicate.isUndefined(sessionOverride) && isReasoningEffort(sessionOverride)) {
    return Option.some(sessionOverride)
  }
  return Option.fromUndefinedOr(agent.reasoningEffort)
}

export const getSingleText = (message: Message): Option.Option<string> =>
  Option.fromUndefinedOr(messageSingleText(message.parts))

export const messageText = (message: Message): string =>
  messagePartsTextLines(message.parts).join("\n")

export const assistantMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:assistant:${step}`)

export const toolResultMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:tool-result:${step}`)
/** The durable instruction that follows a step whose stream failed after partial output. */
export const continuationMessageIdForTurn = (messageId: MessageId, step: number): MessageId =>
  MessageId.make(`${messageId}:continuation:${step}`)

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
