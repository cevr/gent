import { extension } from "../api.js"
import { ResearchTool } from "./research-tool.js"

export const ResearchExtension = extension("@gent/research", (ext) => {
  ext.tool(ResearchTool)
})
