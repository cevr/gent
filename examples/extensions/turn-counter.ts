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
  ExtensionHost,
  type ExtensionState,
} from "@gent/core/extensions/api"

class TurnCounterState extends Context.Service<TurnCounterState, ExtensionState<number>>()(
  "examples/extensions/turn-counter/TurnCounterState",
) {}

export default defineExtension({
  id: "turn-counter",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineStateResource({
        id: "example/turn-counter/state",
        tag: TurnCounterState,
        scope: "process",
        initial: 0,
      }),
    )
    yield* host.on("turnAfter", () =>
      Effect.gen(function* () {
        const state = yield* TurnCounterState
        yield* state.update((turns) => turns + 1)
      }),
    )
    yield* host.on("systemPrompt", (input) =>
      Effect.gen(function* () {
        const state = yield* TurnCounterState
        const turns = yield* state.get
        return `${input.basePrompt}\nThis is turn ${turns + 1}.`
      }),
    )
  }),
})
