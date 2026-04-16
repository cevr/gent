import { extension } from "@gent/core/extensions/api"
import { ReviewTool } from "./review-tool.js"

export const ReviewExtension = extension("@gent/review", ({ ext }) => ext.tools(ReviewTool))
