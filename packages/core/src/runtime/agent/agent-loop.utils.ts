import type { AgentDefinition } from "../../domain/agent.js"
import { getToolId, getToolMetadata, type ToolCapability } from "../../domain/capability/tool.js"
import type { Message } from "../../domain/message.js"
import { messagePartsToolCallParts } from "../../domain/message-part-display.js"
import { type ActorCommandId, MessageId } from "../../domain/ids.js"
import { Predicate } from "effect"
import type { PromptSection } from "../../domain/prompt.js"

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
    sections.push({
      id: "tool-list",
      content: `## Available Tools\n\n${snippets.join("\n")}`,
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
      content: `## Tool Guidelines\n\n${deduped.map((g) => `- ${g}`).join("\n")}`,
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

export const toolResultMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.make(`${messageId}:tool-result:${step}`)
/** The durable instruction that follows a step whose stream failed after partial output. */
export const continuationMessageIdForTurn = (messageId: MessageId, step: number): MessageId =>
  MessageId.make(`${messageId}:continuation:${step}`)

/**
 * The durable instruction that opens the last step a turn is allowed.
 *
 * Separate from `continuationMessageIdForTurn` because it is not a
 * continuation: continuations are bounded per turn and answer a step that went
 * wrong, while this one opens a step the budget itself ended.
 */
export const finalStepMessageIdForTurn = (messageId: MessageId): MessageId =>
  MessageId.make(`${messageId}:final-step`)

export const interjectionMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:interjection`)

export const toolCallsFromMessage = (message: Message) => messagePartsToolCallParts(message.parts)
