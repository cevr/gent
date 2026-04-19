import { defineExtension, tool } from "@gent/core/extensions/api"
import { ReviewTool } from "./review-tool.js"

export const ReviewExtension = defineExtension({
  id: "@gent/review",
  capabilities: [tool(ReviewTool)],
})
