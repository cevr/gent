import { extension } from "./api.js"
import { DelegateTool } from "../tools/delegate.js"
import { FinderTool } from "../tools/finder.js"
import { LibrarianTool } from "../tools/librarian.js"
import { CounselTool } from "../tools/counsel.js"
import { CodeReviewTool } from "../tools/code-review.js"
import { RepoExplorerTool } from "../tools/repo-explorer.js"
import { SearchSkillsTool } from "../tools/search-skills.js"

export const SubagentToolsExtension = extension("@gent/subagent-tools", (ext) => {
  ext.tool(DelegateTool)
  ext.tool(FinderTool)
  ext.tool(LibrarianTool)
  ext.tool(CounselTool)
  ext.tool(CodeReviewTool)
  ext.tool(RepoExplorerTool)
  ext.tool(SearchSkillsTool)
})
