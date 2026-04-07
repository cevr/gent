import { extension } from "../api.js"
import { AuditTool } from "./audit-tool.js"

export const AuditExtension = extension("@gent/audit", ({ ext }) => ext.tools(AuditTool))
