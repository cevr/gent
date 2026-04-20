/**
 * Example: `prompt.system` Pipeline that appends project-specific rules to
 * the system prompt.
 */
import { Effect } from "effect"
import { defineExtension, pipeline } from "@gent/core/extensions/api"

export default defineExtension({
  id: "prompt-rules",
  pipelines: [
    pipeline("prompt.system", (input, next) =>
      next(input).pipe(
        Effect.map(
          (result) =>
            result +
            "\n\n## Project Rules\n- Always write tests for new functions.\n- Use conventional commits.",
        ),
      ),
    ),
  ],
})
