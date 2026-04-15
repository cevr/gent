import { extension, PermissionRule } from "../api.js"
import { BashTool } from "./bash.js"

export const ExecToolsExtension = extension("@gent/exec-tools", ({ ext }) =>
  ext.tools(BashTool).permissionRules(
    new PermissionRule({
      tool: "bash",
      pattern: "git\\s+(add\\s+[-.]|push\\s+--force|reset\\s+--hard|clean\\s+-f)",
      action: "deny",
    }),
    new PermissionRule({ tool: "bash", pattern: "rm\\s+-rf\\s+/", action: "deny" }),
  ),
)
