import { describe, it, expect } from "effect-bun-test"
import { Effect, Ref, Layer } from "effect"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import type { BranchId, SessionId } from "@gent/core/domain/ids"

const test = it.live.layer(ExtensionTurnControl.Test())

describe("ExtensionTurnControl", () => {
  test("Test layer queueFollowUp is a no-op", () =>
    Effect.gen(function* () {
      const tc = yield* ExtensionTurnControl
      yield* tc.queueFollowUp({
        sessionId: "s1" as SessionId,
        branchId: "b1" as BranchId,
        content: "follow up",
      })
    }))

  test("Test layer interject is a no-op", () =>
    Effect.gen(function* () {
      const tc = yield* ExtensionTurnControl
      yield* tc.interject({
        sessionId: "s1" as SessionId,
        branchId: "b1" as BranchId,
        content: "urgent",
      })
    }))

  it.live("custom test layer captures calls", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([])
      const customLayer = Layer.succeed(ExtensionTurnControl, {
        queueFollowUp: (input) => Ref.update(calls, (arr) => [...arr, `followUp:${input.content}`]),
        interject: (input) => Ref.update(calls, (arr) => [...arr, `interject:${input.content}`]),
      })

      const result = yield* Effect.gen(function* () {
        const tc = yield* ExtensionTurnControl
        yield* tc.queueFollowUp({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          content: "hello",
        })
        yield* tc.interject({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          content: "urgent",
        })
        return yield* Ref.get(calls)
      }).pipe(Effect.provide(customLayer))

      expect(result).toEqual(["followUp:hello", "interject:urgent"])
    }),
  )
})
