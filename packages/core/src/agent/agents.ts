import type { ModelId } from "../model"
import { defineAgent } from "./agent-definition"
import {
  ARCHITECT_PROMPT,
  COMPACTION_PROMPT,
  DEFAULT_PROMPT,
  DEEP_PROMPT,
  EXPLORE_PROMPT,
} from "./agent-prompts"

export const Agents = {
  default: defineAgent({
    name: "default",
    description: "General purpose - full tool access, can execute code changes",
    kind: "primary",
    canDelegateToAgents: ["explore", "architect"],
    systemPromptAddendum: DEFAULT_PROMPT,
    preferredModel: "openai/opus-4.5" as ModelId,
  }),

  deep: defineAgent({
    name: "deep",
    description: "Deep reasoning mode - thorough analysis, slower/longer answers",
    kind: "primary",
    canDelegateToAgents: ["explore", "architect"],
    systemPromptAddendum: DEEP_PROMPT,
    preferredModel: "openai/codex-5.2" as ModelId,
  }),

  explore: defineAgent({
    name: "explore",
    description: "Fast codebase exploration - finds files, searches patterns",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob", "bash"],
    systemPromptAddendum: EXPLORE_PROMPT,
    preferredModel: "anthropic/claude-haiku-4" as ModelId,
  }),

  architect: defineAgent({
    name: "architect",
    description: "Designs implementation approaches",
    kind: "subagent",
    allowedTools: ["read", "grep", "glob", "webfetch", "websearch"],
    systemPromptAddendum: ARCHITECT_PROMPT,
  }),

  compaction: defineAgent({
    name: "compaction",
    kind: "system",
    hidden: true,
    allowedTools: [],
    systemPromptAddendum: COMPACTION_PROMPT,
  }),

  title: defineAgent({
    name: "title",
    kind: "system",
    hidden: true,
    allowedTools: [],
    temperature: 0.5,
  }),
} as const

export type BuiltinAgentName = keyof typeof Agents
