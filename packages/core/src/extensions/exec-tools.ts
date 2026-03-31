import { extension } from "./api.js"
import { BashTool } from "../tools/bash.js"

export const ExecToolsExtension = extension("@gent/exec-tools", (ext) => {
  ext.tool(BashTool)
})
