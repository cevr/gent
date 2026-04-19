/**
 * Example: `prompt.system` Pipeline that appends project-specific rules to
 * the system prompt.
 */
import { Effect } from "effect"
import { defineExtension, definePipeline, pipelineContribution } from "@gent/core/extensions/api"

export default defineExtension({
  id: "prompt-rules",
  contributions: () => [
    pipelineContribution(
      definePipeline("prompt.system", (input, next) =>
        next(input).pipe(
          Effect.map(
            (result) =>
              result +
              "\n\n## Project Rules\n- Always write tests for new functions.\n- Use conventional commits.",
          ),
        ),
      ),
    ),
  ],
})
