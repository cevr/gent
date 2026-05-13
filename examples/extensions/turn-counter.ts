/**
 * Example: Stateful extension that counts completed turns.
 *
 * Uses process-scoped extension state incremented by a `turnAfter` hook
 * and injected by a `systemPrompt` hook.
 */
import { Context, Effect } from "effect"
import {
  defineExtension,
  defineStateResource,
  hook,
  type ExtensionState,
} from "@gent/core/extensions/api"

class TurnCounterState extends Context.Service<TurnCounterState, ExtensionState<number>>()(
  "examples/extensions/turn-counter/TurnCounterState",
) {}

export default defineExtension({
  id: "turn-counter",
  resources: [defineStateResource({ tag: TurnCounterState, scope: "process", initial: 0 })],
  hooks: [
    hook.turnAfter(() =>
      Effect.gen(function* () {
        const state = yield* TurnCounterState
        yield* state.update((turns) => turns + 1)
      }),
    ),
    hook.systemPrompt((input) =>
      Effect.gen(function* () {
        const state = yield* TurnCounterState
        const turns = yield* state.get
        return `${input.basePrompt}\nThis is turn ${turns + 1}.`
      }),
    ),
  ],
})
