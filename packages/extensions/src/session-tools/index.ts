import type { Effect } from "effect"
import { extension, type SystemPromptInput } from "@gent/core/extensions/api"
import { SearchSessionsTool } from "./search-sessions.js"
import { ReadSessionTool } from "./read-session.js"
import { RenameSessionTool } from "./rename-session.js"

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

export const SessionToolsExtension = extension("@gent/session-tools", ({ ext }) =>
  ext
    .tools(SearchSessionsTool, ReadSessionTool, RenameSessionTool)
    .on(
      "prompt.system",
      (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) =>
        input.interactive === false
          ? next(input)
          : next({ ...input, basePrompt: input.basePrompt + NAMING_INSTRUCTION }),
    ),
)
