import {
  defineExtension,
  promptSectionContribution,
  toolContribution,
} from "@gent/core/extensions/api"
import { PRINCIPLE_NAMES } from "./data.js"
import { PrinciplesTool } from "./principles-tool.js"

const PRINCIPLES_LIST = `## Principles

The following principles govern architectural and implementation decisions.
Use the \`principles\` tool to read specific principles before making decisions.

${PRINCIPLE_NAMES.map((name) => `- ${name}`).join("\n")}`

export const PrinciplesExtension = defineExtension({
  id: "@gent/principles",
  contributions: () => [
    promptSectionContribution({ id: "principles", content: PRINCIPLES_LIST, priority: 55 }),
    toolContribution(PrinciplesTool),
  ],
})
