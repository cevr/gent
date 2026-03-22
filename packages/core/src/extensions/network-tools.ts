import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { WebFetchTool } from "../tools/webfetch.js"
import { WebSearchTool } from "../tools/websearch.js"

export const NetworkToolsExtension = defineExtension({
  manifest: { id: "@gent/network-tools" },
  setup: () =>
    Effect.succeed({
      tools: [WebFetchTool, WebSearchTool],
    }),
})
