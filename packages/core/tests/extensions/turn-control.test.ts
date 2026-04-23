import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Ref, Stream } from "effect"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const test = it.live.layer(ExtensionTurnControl.Test())

describe("ExtensionTurnControl", () => {
  test("Test layer queueFollowUp is a no-op", () =>
    Effect.gen(function* () {
      const tc = yield* ExtensionTurnControl
      yield* tc.queueFollowUp({
        sessionId: SessionId.of("s1"),
        branchId: BranchId.of("b1"),
        content: "follow up",
      })
    }))

  test("Test layer interject is a no-op", () =>
    Effect.gen(function* () {
      const tc = yield* ExtensionTurnControl
      yield* tc.interject({
        sessionId: SessionId.of("s1"),
        branchId: BranchId.of("b1"),
        content: "urgent",
      })
    }))

  it.live("custom test layer captures calls", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([])
      const customLayer = Layer.succeed(ExtensionTurnControl, {
        queueFollowUp: (input) => Ref.update(calls, (arr) => [...arr, `followUp:${input.content}`]),
        interject: (input) => Ref.update(calls, (arr) => [...arr, `interject:${input.content}`]),
        commands: Stream.empty,
      })

      const result = yield* Effect.gen(function* () {
        const tc = yield* ExtensionTurnControl
        yield* tc.queueFollowUp({
          sessionId: SessionId.of("s1"),
          branchId: BranchId.of("b1"),
          content: "hello",
        })
        yield* tc.interject({
          sessionId: SessionId.of("s1"),
          branchId: BranchId.of("b1"),
          content: "urgent",
        })
        return yield* Ref.get(calls)
      }).pipe(Effect.provide(customLayer))

      expect(result).toEqual(["followUp:hello", "interject:urgent"])
    }),
  )

  it.live("Live exposes queued commands through the mailbox stream", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const tc = yield* ExtensionTurnControl

        yield* tc.queueFollowUp({
          sessionId: SessionId.of("s1"),
          branchId: BranchId.of("b1"),
          content: "queued",
        })
        yield* tc.interject({
          sessionId: SessionId.of("s1"),
          branchId: BranchId.of("b1"),
          content: "urgent",
        })

        const commands = yield* Stream.runCollect(Stream.take(tc.commands, 2))
        expect(Array.from(commands)).toEqual([
          {
            _tag: "QueueFollowUp",
            sessionId: SessionId.of("s1"),
            branchId: BranchId.of("b1"),
            content: "queued",
          },
          {
            _tag: "Interject",
            sessionId: SessionId.of("s1"),
            branchId: BranchId.of("b1"),
            content: "urgent",
          },
        ])
      }).pipe(Effect.provide(ExtensionTurnControl.Live))
    }),
  )
})
