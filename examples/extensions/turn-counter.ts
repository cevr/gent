/**
 * Example: Stateful extension with reduce + derive.
 *
 * Tracks turn count and injects it into the system prompt.
 */
import { simpleExtension } from "@gent/core/extensions/api"

export default simpleExtension("turn-counter", (ext) => {
  ext.state({
    initial: { turns: 0 },
    reduce: (state, event) => {
      if (event.type === "turn-completed") {
        return { state: { turns: state.turns + 1 } }
      }
      return { state }
    },
    derive: (state) => ({
      promptSections: [
        {
          id: "turn-count",
          content: `This is turn ${state.turns + 1} of the conversation.`,
          priority: 90,
        },
      ],
    }),
  })
})
