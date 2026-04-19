import { defineAgent, defineExtension, ModelId, tool } from "@gent/core/extensions/api"
import { AuditTool } from "./audit-tool.js"

const AUDITOR_PROMPT = `
Auditor agent. Audit code for a specific concern category.
Read files, identify issues, produce concrete findings.
Every finding must reference a specific file and line.
Stay scoped to the assigned concern — do not drift into adjacent categories.
Use the principles tool for architectural concerns.
`.trim()

export const auditor = defineAgent({
  name: "auditor",
  description: "Audits code for a specific concern category",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: ["grep", "glob", "read", "memory_search", "bash"],
  systemPromptAddendum: AUDITOR_PROMPT,
})

export const AuditExtension = defineExtension({
  id: "@gent/audit",
  capabilities: [tool(AuditTool)],
  agents: [auditor],
})
