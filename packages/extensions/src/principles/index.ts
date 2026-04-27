import { defineExtension } from "@gent/core/extensions/api"
import { PrinciplesTool } from "./principles-tool.js"

export const PrinciplesExtension = defineExtension({
  id: "@gent/principles",
  tools: [PrinciplesTool],
})
