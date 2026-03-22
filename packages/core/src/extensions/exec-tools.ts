import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { BashTool } from "../tools/bash.js"

export const ExecToolsExtension = defineExtension({
  manifest: { id: "@gent/exec-tools" },
  setup: () =>
    Effect.succeed({
      tools: [BashTool],
    }),
})
