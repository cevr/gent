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
import type { AssistantDraft } from "./agent-loop.state.js"

const VALID_REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

export const buildSystemPrompt = (basePrompt: string, agent: AgentDefinition): string => {
  const parts: string[] = [basePrompt]

  if (agent.systemPromptAddendum !== undefined && agent.systemPromptAddendum !== "") {
    parts.push(`\n\n## Agent: ${agent.name}\n${agent.systemPromptAddendum}`)
  }

  return parts.join("")
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
