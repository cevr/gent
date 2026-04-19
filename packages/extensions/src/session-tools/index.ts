import { defineExtension, definePipeline, pipeline } from "@gent/core/extensions/api"
import { SearchSessionsTool } from "./search-sessions.js"
import { ReadSessionTool } from "./read-session.js"
import { RenameSessionTool } from "./rename-session.js"

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

export const SessionToolsExtension = defineExtension({
  id: "@gent/session-tools",
  capabilities: [SearchSessionsTool, ReadSessionTool, RenameSessionTool],
  pipelines: [
    pipeline(
      definePipeline("prompt.system", (input, next) =>
        input.interactive === false
          ? next(input)
          : next({ ...input, basePrompt: input.basePrompt + NAMING_INSTRUCTION }),
      ),
    ),
  ],
})
