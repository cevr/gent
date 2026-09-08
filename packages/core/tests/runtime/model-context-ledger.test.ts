import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { ContextDirective, ModelContextLedger } from "../../src/runtime/model-context-ledger"

describe("model context ledger", () => {
  it.effect("a branch starts without a projection and reports the last one recorded", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger.make
      expect(Option.isNone(yield* ledger.status)).toBe(true)
      yield* ledger.recordProjection({
        estimatedTokens: 10,
        availableInputTokens: 90,
        contextLimitTokens: 100,
        omittedMessages: 0,
      })
      yield* ledger.recordProjection({
        estimatedTokens: 20,
        availableInputTokens: 80,
        contextLimitTokens: 100,
        omittedMessages: 2,
        compactedRevision: "r2",
      })
      const status = Option.getOrThrow(yield* ledger.status)
      expect(status.estimatedTokens).toBe(20)
      expect(status.compactedRevision).toBe("r2")
    }),
  )

  it.effect(
    "the newest directive wins and stays pending until its projection acknowledges it",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ModelContextLedger.make
        expect(Option.isNone(yield* ledger.pendingDirective)).toBe(true)
        yield* ledger.schedule(ContextDirective.cases.Compact.make({ instructions: "keep paths" }))
        const newWindow = ContextDirective.cases.NewWindow.make({})
        yield* ledger.schedule(newWindow)
        const pending = yield* ledger.pendingDirective
        expect(Option.map(pending, (directive) => directive._tag)).toEqual(Option.some("NewWindow"))
        // A failed projection leaves the directive for the retry.
        expect(Option.isSome(yield* ledger.pendingDirective)).toBe(true)
        yield* ledger.acknowledgeDirective(newWindow)
        expect(Option.isNone(yield* ledger.pendingDirective)).toBe(true)
      }),
  )

  it.effect("acknowledging a replaced directive keeps the newer one", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger.make
      const stale = ContextDirective.cases.Compact.make({})
      yield* ledger.schedule(stale)
      yield* ledger.schedule(ContextDirective.cases.NewWindow.make({}))
      yield* ledger.acknowledgeDirective(stale)
      expect(Option.map(yield* ledger.pendingDirective, (d) => d._tag)).toEqual(
        Option.some("NewWindow"),
      )
      yield* ledger.discardDirective
      expect(Option.isNone(yield* ledger.pendingDirective)).toBe(true)
    }),
  )
})
