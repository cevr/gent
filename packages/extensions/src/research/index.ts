import { defineAgent, defineExtension, ModelId, tool } from "@gent/core/extensions/api"
import { ResearchTool } from "./research-tool.js"

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

export const architect = defineAgent({
  name: "architect",
  description: "Designs implementation approaches",
  model: ModelId.of("anthropic/claude-opus-4-6"),
  allowedTools: ["grep", "glob", "read", "memory_search", "websearch", "webfetch"],
  systemPromptAddendum: ARCHITECT_PROMPT,
})

export const ResearchExtension = defineExtension({
  id: "@gent/research",
  capabilities: [tool(ResearchTool)],
  agents: [architect],
})
