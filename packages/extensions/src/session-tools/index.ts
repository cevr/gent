import { Effect } from "effect"
import { defineExtension, type ProjectionContribution } from "@gent/core/extensions/api"
import { SearchSessionsTool } from "./search-sessions.js"
import { ReadSessionTool } from "./read-session.js"
import { RenameSessionTool } from "./rename-session.js"

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

const SessionNamingProjection: ProjectionContribution<true> = {
  id: "session-naming",
  query: () => Effect.succeed(true),
  systemPrompt: (_value, input) =>
    Effect.succeed(
      input.interactive === false ? input.basePrompt : input.basePrompt + NAMING_INSTRUCTION,
    ),
}

export const SessionToolsExtension = defineExtension({
  id: "@gent/session-tools",
  tools: [SearchSessionsTool, ReadSessionTool, RenameSessionTool],
  projections: [SessionNamingProjection],
})
