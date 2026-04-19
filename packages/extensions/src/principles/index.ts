import { defineExtension, toolContribution } from "@gent/core/extensions/api"
import { PrinciplesTool } from "./principles-tool.js"

// Static prompt section bundled on `PrinciplesTool.prompt` per C7 — folded
// into `Capability.prompt` by the `tool()` smart constructor.
export const PrinciplesExtension = defineExtension({
  id: "@gent/principles",
  contributions: () => [toolContribution(PrinciplesTool)],
})
