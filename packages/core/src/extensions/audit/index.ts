import { extension } from "../api.js"
import { defineAgent, AUDITOR_PROMPT } from "../../domain/agent.js"
import { ModelId } from "../../domain/model.js"
import { AuditTool } from "./audit-tool.js"

export const auditor = defineAgent({
  name: "auditor",
  description: "Audits code for a specific concern category",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: ["grep", "glob", "read", "memory_search", "bash"],
  systemPromptAddendum: AUDITOR_PROMPT,
  persistence: "ephemeral",
})

export const AuditExtension = extension("@gent/audit", ({ ext }) =>
  ext.tools(AuditTool).agents(auditor),
)
