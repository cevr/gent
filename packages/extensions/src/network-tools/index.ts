import { defineExtension, toolContribution } from "@gent/core/extensions/api"
import { WebFetchTool } from "./webfetch.js"
import { WebSearchTool } from "./websearch.js"

export const NetworkToolsExtension = defineExtension({
  id: "@gent/network-tools",
  contributions: () => [toolContribution(WebFetchTool), toolContribution(WebSearchTool)],
})
