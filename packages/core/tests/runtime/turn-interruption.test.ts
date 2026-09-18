import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { makeTurnInterruption, neverInterrupted } from "../../src/runtime/tools.js"

describe("turn interruption", () => {
  it.live("a turn is not interrupted before anything interrupts it", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      expect(yield* turn.interrupted).toBe(false)
    }),
  )

  it.live("interrupting the running turn is visible to work that asks", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      yield* turn.interrupt
      expect(yield* turn.interrupted).toBe(true)
    }),
  )

  it.live("the next turn begins uninterrupted", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      yield* turn.interrupt
      yield* turn.beginTurn
      expect(yield* turn.interrupted).toBe(false)
    }),
  )

  it.live("interrupting twice leaves the turn interrupted", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      yield* turn.interrupt
      yield* turn.interrupt
      expect(yield* turn.interrupted).toBe(true)
    }),
  )

  it.live("branch work with no turn behind it is never interrupted", () =>
    Effect.gen(function* () {
      expect(yield* neverInterrupted.interrupted).toBe(false)
    }),
  )
})
