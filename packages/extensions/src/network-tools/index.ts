import { defineExtension } from "@gent/core/extensions/api"
import { WebFetchTool } from "./webfetch.js"
import { WebSearchTool } from "./websearch.js"

export const NetworkToolsExtension = defineExtension({
  id: "@gent/network-tools",
  capabilities: [WebFetchTool, WebSearchTool],
})
