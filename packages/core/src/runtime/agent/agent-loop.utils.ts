import { ReasoningEffort } from "../../domain/agent.js"
import type { AgentDefinition } from "../../domain/agent.js"
import {
  type ReasoningPart,
  type Message,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
} from "../../domain/message.js"
import { MessageId } from "../../domain/ids.js"
import { Schema } from "effect"
import type { ProviderRequest } from "../../providers/provider.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import {
  compileSystemPrompt,
  withSectionMarkers,
  type PromptSection,
} from "../../server/system-prompt.js"
import type { AssistantDraft } from "./agent-loop.state.js"

const isReasoningEffort = Schema.is(ReasoningEffort)

/**
 * Build the per-turn prompt sections (base + agent addendum + tool list +
 * tool guidelines + delegation targets + extension extras). Returns the
 * unsorted section list so pipeline hooks can rewrite specific sections
 * (e.g. codemode replacing `tool-list` / `tool-guidelines`) before final
 * compilation.
 */
export const buildTurnPromptSections = (
  baseSections: ReadonlyArray<PromptSection>,
  agent: AgentDefinition,
  tools: ReadonlyArray<AnyToolDefinition>,
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

  // Tool list — tools with promptSnippet get listed explicitly
  const snippets = tools
    .filter((t) => t.promptSnippet !== undefined)
    .map((t) => `- **${t.name}**: ${t.promptSnippet}`)
  if (snippets.length > 0) {
    // Wrap with section sentinels so the ACP codemode pipeline can swap
    // this block atomically. Other sections don't need markers because
    // nothing downstream rewrites them — markers cost tokens, only spend
    // them where a hook needs the anchor.
    sections.push({
      id: "tool-list",
      content: withSectionMarkers("tool-list", `## Available Tools\n\n${snippets.join("\n")}`),
      priority: 42,
    })
  }

  // Tool guidelines — collected from active tools + conditional rules
  const guidelines = tools.flatMap((t) => t.promptGuidelines ?? [])
  const hasBash = tools.some((t) => t.name === "bash")
  const dedicatedNames = ["grep", "glob", "read"].filter((n) => tools.some((t) => t.name === n))
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
  const hasDelegate = tools.some((t) => t.name === "delegate")
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
  tools: ReadonlyArray<AnyToolDefinition>,
  extraSections?: ReadonlyArray<PromptSection>,
  delegationTargets?: ReadonlyArray<AgentDefinition>,
): string =>
  compileSystemPrompt(
    buildTurnPromptSections(baseSections, agent, tools, extraSections, delegationTargets),
  )

export const resolveReasoning = (
  agent: AgentDefinition,
  sessionOverride?: string,
): ProviderRequest["reasoning"] | undefined => {
  if (sessionOverride !== undefined && isReasoningEffort(sessionOverride)) {
    return sessionOverride
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

export const assistantMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.of(`${messageId}:assistant:${step}`)

export const toolResultMessageIdForTurn = (messageId: MessageId, step = 1): MessageId =>
  MessageId.of(`${messageId}:tool-result:${step}`)

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
