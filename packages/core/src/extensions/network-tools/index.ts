import { extension } from "../api.js"
import { WebFetchTool } from "./webfetch.js"
import { WebSearchTool } from "./websearch.js"

export const NetworkToolsExtension = extension("@gent/network-tools", (ext) => {
  ext.tool(WebFetchTool)
  ext.tool(WebSearchTool)
})
