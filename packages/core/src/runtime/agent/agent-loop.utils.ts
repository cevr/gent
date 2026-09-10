import {
  isReasoningEffort,
  type AgentDefinition,
  type ReasoningEffort,
} from "../../domain/agent.js"
import { getToolId, getToolMetadata, type ToolCapability } from "../../domain/capability/tool.js"
import type { Message } from "../../domain/message.js"
import {
  messagePartsReasoning,
  messagePartsText,
  messagePartsTextLines,
  messagePartsToolCallParts,
  messageSingleText,
} from "../../domain/message-part-projection.js"
import { type ActorCommandId, MessageId } from "../../domain/ids.js"
import { Option, Predicate } from "effect"
import { compileSystemPrompt, withSectionMarkers, type PromptSection } from "../../domain/prompt.js"
import type { AssistantDraft } from "./agent-loop.state.js"

/**
 * Build the per-turn prompt sections (base + agent addendum + tool list +
 * tool guidelines + extension extras). Returns the
 * unsorted section list so prompt slots can rewrite specific sections
 * (e.g. codemode replacing `tool-list` / `tool-guidelines`) before final
 * compilation.
 */
export const buildTurnPromptSections = (
  baseSections: ReadonlyArray<PromptSection>,
  agent: AgentDefinition,
  tools: ReadonlyArray<ToolCapability>,
  extraSections?: ReadonlyArray<PromptSection>,
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

  // Tool guidelines — collected from active tools + conditional rules
  // Every guideline comes from the tool that owns it. The loop does not know
  // tool names -- a tool that wants to steer the model toward another one says
  // so in its own `promptGuidelines`.
  const guidelines = toolsWithMetadata.flatMap((tool) => tool.metadata.promptGuidelines ?? [])
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
): Option.Option<ReasoningEffort> => {
  if (!Predicate.isUndefined(sessionOverride) && isReasoningEffort(sessionOverride)) {
    return Option.some(sessionOverride)
  }
  return Option.fromUndefinedOr(agent.reasoningEffort)
}

export const getSingleText = (message: Message): Option.Option<string> =>
  Option.fromUndefinedOr(messageSingleText(message.parts))

export const messageText = (message: Message): string =>
  messagePartsTextLines(message.parts).join("\n")

export const toolResultMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:tool-result:${step}`)
/** The durable instruction that follows a step whose stream failed after partial output. */
export const continuationMessageIdForTurn = (messageId: MessageId, step: number): MessageId =>
  MessageId.make(`${messageId}:continuation:${step}`)

export const interjectionMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:interjection`)

export const assistantDraftFromMessage = (message: Message): AssistantDraft => ({
  text: messagePartsText(message.parts),
  reasoning: messagePartsReasoning(message.parts),
  toolCalls: messagePartsToolCallParts(message.parts),
})
