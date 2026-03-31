import { extension } from "./api.js"
import { WebFetchTool } from "../tools/webfetch.js"
import { WebSearchTool } from "../tools/websearch.js"

export const NetworkToolsExtension = extension("@gent/network-tools", (ext) => {
  ext.tool(WebFetchTool)
  ext.tool(WebSearchTool)
})
