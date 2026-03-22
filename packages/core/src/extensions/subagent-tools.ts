import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { DelegateTool } from "../tools/delegate.js"
import { HandoffTool } from "../tools/handoff.js"
import { FinderTool } from "../tools/finder.js"
import { LibrarianTool } from "../tools/librarian.js"
import { CounselTool } from "../tools/counsel.js"
import { CodeReviewTool } from "../tools/code-review.js"
import { RepoExplorerTool } from "../tools/repo-explorer.js"

export const SubagentToolsExtension = defineExtension({
  manifest: { id: "@gent/subagent-tools" },
  setup: () =>
    Effect.succeed({
      tools: [
        DelegateTool,
        HandoffTool,
        FinderTool,
        LibrarianTool,
        CounselTool,
        CodeReviewTool,
        RepoExplorerTool,
      ],
    }),
})
