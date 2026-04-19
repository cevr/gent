import { defineExtension, toolContribution } from "@gent/core/extensions/api"
import { BashTool } from "./bash.js"

// Permission rules are bundled on `BashTool.permissionRules` per C7 — folded
// into `Capability.permissionRules` by the `tool()` smart constructor.
export const ExecToolsExtension = defineExtension({
  id: "@gent/exec-tools",
  contributions: () => [toolContribution(BashTool)],
})
