import { defineAgent, defineExtension, ModelId, agentContribution } from "@gent/core/extensions/api"

const COWORK_PROMPT = `
Cowork agent. Fast, practical, execute changes.
- Minimal prose. Summarize changes at turn end.
- Ask only when blocked. Investigate first.
- Prefer direct tool use over delegation for simple tasks.
- When editing multiple files, batch related changes together.
- Follow the plan. One commit per batch. Don't skip steps.
- No deferring, no skipping, no backing out of plan items without asking.
- When stuck: read more code, break the problem smaller, ask with options.
- When unsure about an approach: use the counsel tool for a second opinion.
- Gate after each batch: typecheck, lint, test.
`.trim()

const DEEPWORK_PROMPT = `
Deepwork agent. Thorough analysis, careful tradeoffs, explicit assumptions.
- Less chatty, more focused. Minimize prose, maximize analysis.
- Prefer correctness over speed. Verify before acting.
- Read widely before narrowing. Explore adjacent code that might be affected.
- Cite specific file paths and line numbers for every claim.
- Read principles before architectural decisions.
- Still execute when confident — analysis without action is incomplete.
`.trim()

const EXPLORE_PROMPT = `
Explore agent. Rapid codebase scanning and multi-step search.
- Chain grep/read/glob to answer precisely. Be exhaustive.
- Report: file paths, line numbers, brief context.
- End with next steps or open questions.
`.trim()

const SUMMARIZER_PROMPT = `
Summarizer agent. Summarize prior context. Focus decisions, open questions, current state.
`.trim()

const cowork = defineAgent({
  name: "cowork",
  description: "General purpose - full tool access, can execute code changes",
  model: ModelId.of("anthropic/claude-opus-4-6"),
  systemPromptAddendum: COWORK_PROMPT,
})

const deepwork = defineAgent({
  name: "deepwork",
  description: "Deep analysis with thorough reasoning — alternative model perspective",
  model: ModelId.of("openai/gpt-5.4"),
  systemPromptAddendum: DEEPWORK_PROMPT,
  reasoningEffort: "high",
})

const explore = defineAgent({
  name: "explore",
  description: "Fast codebase exploration - finds files, searches patterns",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: ["grep", "glob", "read", "memory_search", "bash"],
  systemPromptAddendum: EXPLORE_PROMPT,
})

const summarizer = defineAgent({
  name: "summarizer",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: [],
  systemPromptAddendum: SUMMARIZER_PROMPT,
})

const title = defineAgent({
  name: "title",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: [],
  temperature: 0.5,
})

/** Core agents — general-purpose agents not tied to a specific tool extension. */
export const CoreAgents = [cowork, deepwork, explore, summarizer, title] as const

export const AgentsExtension = defineExtension({
  id: "@gent/agents",
  contributions: () => CoreAgents.map((a) => agentContribution(a)),
})
