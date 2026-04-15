import { extension } from "../api.js"
import { defineAgent, ARCHITECT_PROMPT } from "../../domain/agent.js"
import { ModelId } from "../../domain/model.js"
import { ResearchTool } from "./research-tool.js"

export const architect = defineAgent({
  name: "architect",
  description: "Designs implementation approaches",
  model: ModelId.of("anthropic/claude-opus-4-6"),
  allowedTools: ["grep", "glob", "read", "memory_search", "websearch", "webfetch"],
  systemPromptAddendum: ARCHITECT_PROMPT,
})

export const ResearchExtension = extension("@gent/research", ({ ext }) =>
  ext.tools(ResearchTool).agents(architect),
)
