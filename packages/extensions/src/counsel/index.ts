import { defineExtension, toolContribution } from "@gent/core/extensions/api"
import { CounselTool } from "./counsel-tool.js"

export const CounselExtension = defineExtension({
  id: "@gent/counsel",
  contributions: () => [toolContribution(CounselTool)],
})
