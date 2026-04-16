/**
 * Example: Stateful extension that counts completed turns.
 *
 * Uses a closure counter incremented on turn.after, injected via prompt.system.
 */
import {
  defineExtension,
  defineInterceptor,
  interceptorContribution,
} from "@gent/core/extensions/api"

export default defineExtension({
  id: "turn-counter",
  contributions: () => {
    let turns = 0
    return [
      interceptorContribution(
        defineInterceptor("turn.after", (input, next) => {
          turns++
          return next(input)
        }),
      ),
      interceptorContribution(
        defineInterceptor("prompt.system", (input, next) =>
          next({ ...input, basePrompt: input.basePrompt + `\nThis is turn ${turns + 1}.` }),
        ),
      ),
    ]
  },
})
