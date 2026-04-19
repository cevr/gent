/**
 * Example: Stateful extension that counts completed turns.
 *
 * Uses a closure counter incremented on `turn.after` (Subscription, void
 * observer), injected via `prompt.system` (Pipeline, transformer).
 */
import { Effect } from "effect"
import {
  defineExtension,
  definePipeline,
  defineSubscription,
  pipelineContribution,
  subscriptionContribution,
} from "@gent/core/extensions/api"

export default defineExtension({
  id: "turn-counter",
  contributions: () => {
    let turns = 0
    return [
      subscriptionContribution(
        defineSubscription("turn.after", "continue", () => {
          turns++
          return Effect.void
        }),
      ),
      pipelineContribution(
        definePipeline("prompt.system", (input, next) =>
          next({ ...input, basePrompt: input.basePrompt + `\nThis is turn ${turns + 1}.` }),
        ),
      ),
    ]
  },
})
