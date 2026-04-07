import { extension } from "../api.js"
import { BashTool } from "./bash.js"

export const ExecToolsExtension = extension("@gent/exec-tools", ({ ext }) => ext.tools(BashTool))
