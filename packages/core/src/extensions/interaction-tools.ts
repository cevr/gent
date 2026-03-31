import { extension } from "./api.js"
import { AskUserTool } from "../tools/ask-user.js"
import { PromptTool } from "../tools/prompt.js"
import { TodoReadTool, TodoWriteTool } from "../tools/todo.js"

export const InteractionToolsExtension = extension("@gent/interaction-tools", (ext) => {
  ext.tool(AskUserTool)
  ext.tool(PromptTool)
  ext.tool(TodoReadTool)
  ext.tool(TodoWriteTool)
})
