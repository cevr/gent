/**
 * Example: prompt.system hook that appends project-specific rules.
 */
import { Effect } from "effect"
import { extension } from "@gent/core/extensions/api"

export default extension("prompt-rules", ({ ext }) =>
  ext.on("prompt.system", (input, next) =>
    next(input).pipe(
      Effect.map(
        (result) =>
          result +
          "\n\n## Project Rules\n- Always write tests for new functions.\n- Use conventional commits.",
      ),
    ),
  ),
)
