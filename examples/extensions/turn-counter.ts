/**
 * Example: Stateful extension that counts completed turns.
 *
 * Uses a closure counter incremented on `turn.after` (Subscription, void
 * observer), injected via `prompt.system` (Pipeline, transformer).
 *
 * Cross-bucket shared state is hoisted to module scope so both buckets
 * see the same counter.
 */
import { Effect } from "effect"
import { defineExtension, pipeline, subscription } from "@gent/core/extensions/api"

let turns = 0

export default defineExtension({
  id: "turn-counter",
  subscriptions: [
    subscription("turn.after", "continue", () => {
      turns++
      return Effect.void
    }),
  ],
  pipelines: [
    pipeline("prompt.system", (input, next) =>
      next({ ...input, basePrompt: input.basePrompt + `\nThis is turn ${turns + 1}.` }),
    ),
  ],
})
