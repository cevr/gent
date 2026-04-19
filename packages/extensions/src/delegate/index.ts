import { defineExtension } from "@gent/core/extensions/api"
import { DelegateTool } from "./delegate-tool.js"

export const DelegateExtension = defineExtension({
  id: "@gent/delegate",
  capabilities: [DelegateTool],
})
