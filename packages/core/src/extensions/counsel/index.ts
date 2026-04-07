import { extension } from "../api.js"
import { CounselTool } from "./counsel-tool.js"

export const CounselExtension = extension("@gent/counsel", ({ ext }) => ext.tools(CounselTool))
