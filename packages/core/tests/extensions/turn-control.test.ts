import { describe, test, expect } from "bun:test"
import { Effect, Ref, Layer } from "effect"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import type { BranchId, SessionId } from "@gent/core/domain/ids"

describe("ExtensionTurnControl", () => {
  test("Test layer queueFollowUp is a no-op", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tc = yield* ExtensionTurnControl
        yield* tc.queueFollowUp({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          content: "follow up",
        })
      }).pipe(Effect.provide(ExtensionTurnControl.Test())),
    )
  })

  test("Test layer interject is a no-op", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const tc = yield* ExtensionTurnControl
        yield* tc.interject({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          content: "urgent",
        })
      }).pipe(Effect.provide(ExtensionTurnControl.Test())),
    )
  })

  test("custom test layer captures calls", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make<string[]>([])
        const customLayer = Layer.succeed(ExtensionTurnControl, {
          queueFollowUp: (input) =>
            Ref.update(calls, (arr) => [...arr, `followUp:${input.content}`]),
          interject: (input) => Ref.update(calls, (arr) => [...arr, `interject:${input.content}`]),
        })

        return yield* Effect.gen(function* () {
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
      }),
    )

    expect(result).toEqual(["followUp:hello", "interject:urgent"])
  })
})
