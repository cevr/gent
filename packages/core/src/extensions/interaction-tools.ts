import { extension } from "./api.js"
import { AskUserTool } from "../tools/ask-user.js"
import { PromptTool } from "../tools/prompt.js"

export const InteractionToolsExtension = extension("@gent/interaction-tools", (ext) => {
  ext.tool(AskUserTool)
  ext.tool(PromptTool)
})
