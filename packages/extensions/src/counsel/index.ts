import { extension } from "@gent/core/extensions/api"
import { CounselTool } from "./counsel-tool.js"

export const CounselExtension = extension("@gent/counsel", ({ ext }) => ext.tools(CounselTool))
