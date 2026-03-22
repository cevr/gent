import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { SearchSessionsTool } from "../tools/search-sessions.js"
import { ReadSessionTool } from "../tools/read-session.js"

export const SessionToolsExtension = defineExtension({
  manifest: { id: "@gent/session-tools" },
  setup: () =>
    Effect.succeed({
      tools: [SearchSessionsTool, ReadSessionTool],
    }),
})
