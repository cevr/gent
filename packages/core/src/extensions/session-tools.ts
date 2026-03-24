import { Effect } from "effect"
import { defineExtension, defineInterceptor, type SystemPromptInput } from "../domain/extension.js"
import { SearchSessionsTool } from "../tools/search-sessions.js"
import { ReadSessionTool } from "../tools/read-session.js"
import { RenameSessionTool } from "../tools/rename-session.js"

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

export const SessionToolsExtension = defineExtension({
  manifest: { id: "@gent/session-tools" },
  setup: () =>
    Effect.succeed({
      tools: [SearchSessionsTool, ReadSessionTool, RenameSessionTool],
      hooks: {
        interceptors: [
          defineInterceptor(
            "prompt.system",
            (input: SystemPromptInput, next: (i: SystemPromptInput) => Effect.Effect<string>) =>
              next({ ...input, basePrompt: input.basePrompt + NAMING_INSTRUCTION }),
          ),
        ],
      },
    }),
})
