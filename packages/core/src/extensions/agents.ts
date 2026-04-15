import { extension } from "./api.js"
import {
  defineAgent,
  COWORK_PROMPT,
  DEEPWORK_PROMPT,
  EXPLORE_PROMPT,
  SUMMARIZER_PROMPT,
} from "../domain/agent.js"
import { ModelId } from "../domain/model.js"

const cowork = defineAgent({
  name: "cowork",
  description: "General purpose - full tool access, can execute code changes",
  model: ModelId.of("anthropic/claude-opus-4-6"),
  systemPromptAddendum: COWORK_PROMPT,
  role: "primary",
})

const deepwork = defineAgent({
  name: "deepwork",
  description: "Deep analysis with thorough reasoning — alternative model perspective",
  model: ModelId.of("openai/gpt-5.4"),
  systemPromptAddendum: DEEPWORK_PROMPT,
  reasoningEffort: "high",
  role: "reviewer",
})

const explore = defineAgent({
  name: "explore",
  description: "Fast codebase exploration - finds files, searches patterns",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: ["grep", "glob", "read", "memory_search", "bash"],
  systemPromptAddendum: EXPLORE_PROMPT,
  persistence: "ephemeral",
})

const summarizer = defineAgent({
  name: "summarizer",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: [],
  systemPromptAddendum: SUMMARIZER_PROMPT,
  persistence: "ephemeral",
})

const title = defineAgent({
  name: "title",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: [],
  temperature: 0.5,
  persistence: "ephemeral",
})

/** Core agents — general-purpose agents not tied to a specific tool extension. */
export const CoreAgents = [cowork, deepwork, explore, summarizer, title] as const

export const AgentsExtension = extension("@gent/agents", ({ ext }) => ext.agents(...CoreAgents))
