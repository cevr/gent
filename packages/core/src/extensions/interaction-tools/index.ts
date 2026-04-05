import { extension } from "../api.js"
import { AskUserTool } from "./ask-user.js"
import { PromptTool } from "./prompt.js"

export const InteractionToolsExtension = extension("@gent/interaction-tools", (ext) => {
  ext.tool(AskUserTool)
  ext.tool(PromptTool)
})
