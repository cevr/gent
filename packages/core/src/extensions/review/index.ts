import { extension } from "../api.js"
import { ReviewTool } from "./review-tool.js"

export const ReviewExtension = extension("@gent/review", ({ ext }) => ext.tools(ReviewTool))
