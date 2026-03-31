/**
 * Example: prompt.system hook that appends project-specific rules.
 */
import { simpleExtension } from "@gent/core/extensions/api"

export default simpleExtension("prompt-rules", (ext) => {
  ext.on("prompt.system", async (input, next) => {
    const result = await next(input)
    return (
      result +
      "\n\n## Project Rules\n- Always write tests for new functions.\n- Use conventional commits."
    )
  })
})
