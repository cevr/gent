import { defineExtension } from "@gent/core/extensions/api"
import { BashTool } from "./bash.js"

export const ExecToolsExtension = defineExtension({
  id: "@gent/exec-tools",
  capabilities: [BashTool],
})
