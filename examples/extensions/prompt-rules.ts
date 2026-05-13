/**
 * Example: `systemPrompt` hook that appends project-specific rules to the
 * system prompt.
 */
import { Effect } from "effect"
import { defineExtension, hook } from "@gent/core/extensions/api"

export default defineExtension({
  id: "prompt-rules",
  hooks: [
    hook.systemPrompt((input) =>
      Effect.succeed(
        input.basePrompt +
          "\n\n## Project Rules\n- Always write tests for new functions.\n- Use conventional commits.",
      ),
    ),
  ],
})
