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

  it.effect("the newest directive wins and is handed out exactly once", () =>
    Effect.gen(function* () {
      const ledger = yield* ModelContextLedger.make
      expect(Option.isNone(yield* ledger.takeDirective)).toBe(true)
      yield* ledger.schedule(ContextDirective.cases.Compact.make({ instructions: "keep paths" }))
      yield* ledger.schedule(ContextDirective.cases.NewWindow.make({}))
      const taken = yield* ledger.takeDirective
      expect(Option.map(taken, (directive) => directive._tag)).toEqual(Option.some("NewWindow"))
      expect(Option.isNone(yield* ledger.takeDirective)).toBe(true)
    }),
  )
})
