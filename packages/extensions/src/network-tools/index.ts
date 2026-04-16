import { extension } from "@gent/core/extensions/api"
import { WebFetchTool } from "./webfetch.js"
import { WebSearchTool } from "./websearch.js"

export const NetworkToolsExtension = extension("@gent/network-tools", ({ ext }) =>
  ext.tools(WebFetchTool, WebSearchTool),
)
