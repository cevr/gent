import { extension } from "../api.js"
import { AuditTool } from "./audit.js"

export const WorkflowToolsExtension = extension("@gent/workflow-tools", (ext) => {
  ext.tool(AuditTool)
})
