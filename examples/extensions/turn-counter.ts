/**
 * Example: Stateful extension that counts completed turns.
 *
 * Uses a closure counter incremented by a `turnAfter` reaction and injected
 * by a `systemPrompt` reaction.
 *
 * Cross-bucket shared state is hoisted to module scope so both buckets
 * see the same counter.
 */
import { Effect } from "effect"
import { defineExtension } from "@gent/core/extensions/api"

let turns = 0

export default defineExtension({
  id: "turn-counter",
  reactions: {
    turnAfter: {
      handler: () =>
        Effect.sync(() => {
          turns++
        }),
    },
    systemPrompt: (input) => Effect.succeed(`${input.basePrompt}\nThis is turn ${turns + 1}.`),
  },
})
