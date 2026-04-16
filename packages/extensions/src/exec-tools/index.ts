import {
  defineExtension,
  PermissionRule,
  permissionRuleContribution,
  toolContribution,
} from "@gent/core/extensions/api"
import { BashTool } from "./bash.js"

export const ExecToolsExtension = defineExtension({
  id: "@gent/exec-tools",
  contributions: () => [
    toolContribution(BashTool),
    permissionRuleContribution(
      new PermissionRule({
        tool: "bash",
        pattern: "git\\s+(add\\s+[-.]|push\\s+--force|reset\\s+--hard|clean\\s+-f)",
        action: "deny",
      }),
    ),
    permissionRuleContribution(
      new PermissionRule({ tool: "bash", pattern: "rm\\s+-rf\\s+/", action: "deny" }),
    ),
  ],
})
