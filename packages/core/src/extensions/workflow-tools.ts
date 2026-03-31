import { extension } from "./api.js"
import { PlanTool } from "../tools/plan.js"
import { AuditTool } from "../tools/audit.js"

export const WorkflowToolsExtension = extension("@gent/workflow-tools", (ext) => {
  ext.tool(PlanTool)
  ext.tool(AuditTool)
})
