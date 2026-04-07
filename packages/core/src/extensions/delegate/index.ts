import { extension } from "../api.js"
import { DelegateTool } from "./delegate-tool.js"
import { RepoTool } from "./repo-explorer.js"
import { SearchSkillsTool } from "./search-skills.js"

export const DelegateExtension = extension("@gent/delegate", (ext) => {
  ext.tool(DelegateTool)
  ext.tool(RepoTool)
  ext.tool(SearchSkillsTool)
})
