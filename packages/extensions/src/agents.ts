import { AgentDefinition, AgentName, defineExtension, ModelId } from "@gent/core/extensions/api"

const COWORK_PROMPT = `
Cowork agent. Fast, practical, execute changes.
- Minimal prose. Summarize changes at turn end.
- Ask only when blocked. Investigate first.
- Prefer direct tool use over delegation for simple tasks.
- When editing multiple files, batch related changes together.
- Follow the plan. One commit per batch. Don't skip steps.
- No deferring, no skipping, no backing out of plan items without asking.
- When stuck: read more code, break the problem smaller, ask with options.
- When unsure about an approach: delegate a second opinion to the deepwork agent.
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

const ARCHITECT_PROMPT = `
Architect agent. Design implementation approach.
- Enumerate structure, tradeoffs, and risks.
- Reference specific files and interfaces.
- No code changes — read-only analysis.
- Plans batched by commit — each batch is one shippable unit.
- Each batch: Goal, Why, Justification (principle names), Files, Changes, Verification.
- No addendums — plans must be cohesive, not main + appendix.
- Use the principles tool to ground justifications.
- End with a sequenced implementation plan.
`.trim()

const REVIEWER_PROMPT = `
Reviewer agent. Examine code changes for bugs, security issues, and improvements.
Run git diff or read specified files, then produce a structured review.

Output format: JSON array of comments. Each comment:
- file: path to file
- line: line number (optional)
- severity: critical | high | medium | low
- type: bug | suggestion | style
- text: description of the issue
- fix: suggested fix (optional)

Severity definitions:
- critical: will cause data loss, security breach, or crash in production
- high: likely bug or regression that affects correctness
- medium: code smell, missed edge case, or maintainability concern
- low: style, naming, or minor improvement

Ground every finding in a specific file and line.
Prioritize root cause over symptoms.
Flag backwards compat / legacy shims as architectural issues.

Only output the JSON array, no other text.
`.trim()

const SUMMARIZER_PROMPT = `
Summarizer agent. Summarize prior context. Focus decisions, open questions, current state.
`.trim()

const cowork = AgentDefinition.make({
  name: AgentName.make("cowork"),
  description: "General purpose - full tool access, can execute code changes",
  model: ModelId.make("anthropic/claude-opus-4-6"),
  systemPromptAddendum: COWORK_PROMPT,
})

const deepwork = AgentDefinition.make({
  name: AgentName.make("deepwork"),
  description: "Deep analysis with thorough reasoning — alternative model perspective",
  model: ModelId.make("openai/gpt-5.4"),
  systemPromptAddendum: DEEPWORK_PROMPT,
  reasoningEffort: "high",
})

const explore = AgentDefinition.make({
  name: AgentName.make("explore"),
  description: "Fast codebase exploration - finds files, searches patterns",
  model: ModelId.make("openai/gpt-5.4-mini"),
  allowedTools: ["grep", "glob", "read", "bash"],
  systemPromptAddendum: EXPLORE_PROMPT,
})

const architect = AgentDefinition.make({
  name: AgentName.make("architect"),
  description: "Designs implementation approaches",
  model: ModelId.make("anthropic/claude-opus-4-6"),
  allowedTools: ["grep", "glob", "read", "websearch", "webfetch"],
  systemPromptAddendum: ARCHITECT_PROMPT,
})

const reviewer = AgentDefinition.make({
  name: AgentName.make("reviewer"),
  description: "Read-only adversarial code review",
  allowedTools: ["grep", "glob", "read"],
  systemPromptAddendum: REVIEWER_PROMPT,
})

const summarizer = AgentDefinition.make({
  name: AgentName.make("summarizer"),
  model: ModelId.make("openai/gpt-5.4-mini"),
  allowedTools: [],
  systemPromptAddendum: SUMMARIZER_PROMPT,
})

const title = AgentDefinition.make({
  name: AgentName.make("title"),
  model: ModelId.make("openai/gpt-5.4-mini"),
  allowedTools: [],
  temperature: 0.5,
})

/** Core agents — general-purpose agents not tied to a specific tool extension. */
export const CoreAgents = [
  cowork,
  deepwork,
  explore,
  architect,
  reviewer,
  summarizer,
  title,
] satisfies ReadonlyArray<AgentDefinition>

export const AgentsExtension = defineExtension({
  id: "@gent/agents",
  agents: [...CoreAgents],
})
