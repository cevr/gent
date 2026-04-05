import { extension } from "../api.js"
import { DelegateTool } from "./delegate.js"
import { FinderTool } from "./finder.js"
import { LibrarianTool } from "./librarian.js"
import { CounselTool } from "./counsel.js"
import { CodeReviewTool } from "./code-review.js"
import { RepoExplorerTool } from "./repo-explorer.js"
import { SearchSkillsTool } from "./search-skills.js"

export const SubagentToolsExtension = extension("@gent/subagent-tools", (ext) => {
  ext.tool(DelegateTool)
  ext.tool(FinderTool)
  ext.tool(LibrarianTool)
  ext.tool(CounselTool)
  ext.tool(CodeReviewTool)
  ext.tool(RepoExplorerTool)
  ext.tool(SearchSkillsTool)
})
