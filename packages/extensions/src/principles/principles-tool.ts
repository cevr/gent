import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core/extensions/api"
import { loadPrinciples, PRINCIPLE_NAMES } from "./data.js"

export const PrinciplesParams = Schema.Struct({
  names: Schema.Union([Schema.Array(Schema.String), Schema.Literal("all")]).annotate({
    description: `Principle names to read, or "all". Available: ${PRINCIPLE_NAMES.join(", ")}`,
  }),
})

export const PrinciplesTool = defineTool({
  name: "principles",
  description:
    "Read governing principles by name. Use before architectural decisions, plan creation, or code review.",
  promptSnippet: "Read governing principles for grounding decisions",
  promptGuidelines: [
    "Read principles before architectural decisions, plan creation, or code review",
    "Reference specific principle names when justifying design choices",
  ],
  params: PrinciplesParams,
  execute: (params) =>
    Effect.sync(() => {
      const principles = loadPrinciples()
      const names = params.names === "all" ? PRINCIPLE_NAMES : params.names

      const results: string[] = []
      const notFound: string[] = []

      for (const name of names) {
        const content = principles.get(name)
        if (content !== undefined) {
          results.push(content)
        } else {
          notFound.push(name)
        }
      }

      const output = results.join("\n\n---\n\n")
      if (notFound.length > 0) {
        return `${output}\n\n[Not found: ${notFound.join(", ")}. Available: ${PRINCIPLE_NAMES.join(", ")}]`
      }
      return output
    }),
})
