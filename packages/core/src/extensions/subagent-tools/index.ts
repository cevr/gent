import { extension } from "../api.js"
import { DelegateTool } from "./delegate.js"
import { CodeReviewTool } from "./code-review.js"
import { RepoTool } from "./repo-explorer.js"
import { SearchSkillsTool } from "./search-skills.js"

export const SubagentToolsExtension = extension("@gent/subagent-tools", (ext) => {
  ext.tool(DelegateTool)
  ext.tool(CodeReviewTool)
  ext.tool(RepoTool)
  ext.tool(SearchSkillsTool)
})
