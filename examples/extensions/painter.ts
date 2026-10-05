/**
 * Example: an agent confined by `paths`. The shipped file tools (`read`,
 * `grep`, `write`, `edit`) reach the films folder to write and the notes
 * folder to read, and nothing else.
 */
import { Effect } from "effect"
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  ExtensionHost,
} from "@gent/core/extensions/api"

export default defineExtension({
  id: "painter",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "agent",
      AgentDefinition.make({
        name: AgentName.make("painter"),
        description: "Paints the films folder; reads the notes",
        tools: ["read", "grep", "write", "edit"],
        paths: [
          { path: "films", access: "write" },
          { path: "notes", access: "read" },
        ],
      }),
    )
  }),
})
