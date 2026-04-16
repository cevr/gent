/**
 * Example: prompt.system interceptor that appends project-specific rules.
 */
import { Effect } from "effect"
import {
  defineExtension,
  defineInterceptor,
  interceptorContribution,
} from "@gent/core/extensions/api"

export default defineExtension({
  id: "prompt-rules",
  contributions: () => [
    interceptorContribution(
      defineInterceptor("prompt.system", (input, next) =>
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
