/**
 * Example: Stateful extension with ext.actor(fromReducer(...)).
 *
 * Tracks turn count and injects it into the system prompt.
 */
import { extension, fromReducer } from "@gent/core/extensions/api"

export default extension("turn-counter", (ext) => {
  ext.actor(
    fromReducer({
      id: "turn-counter",
      initial: { turns: 0 },
      reduce: (state, event) => {
        if (event._tag === "TurnCompleted") {
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
    }),
  )
})
