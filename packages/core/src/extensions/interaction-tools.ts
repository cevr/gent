import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { AskUserTool } from "../tools/ask-user.js"
import { PromptTool } from "../tools/prompt.js"
import { TodoReadTool, TodoWriteTool } from "../tools/todo.js"

export const InteractionToolsExtension = defineExtension({
  manifest: { id: "@gent/interaction-tools" },
  setup: () =>
    Effect.succeed({
      tools: [AskUserTool, PromptTool, TodoReadTool, TodoWriteTool],
    }),
})
