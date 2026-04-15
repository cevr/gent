import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Ref, Layer } from "effect"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
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
        bind: () => Effect.void,
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

  it.live("Live fails loudly before handlers are bound", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const tc = yield* ExtensionTurnControl

        const queueExit = yield* Effect.exit(
          tc.queueFollowUp({
            sessionId: SessionId.of("s1"),
            branchId: BranchId.of("b1"),
            content: "queued-before-bind",
          }),
        )
        const interjectExit = yield* Effect.exit(
          tc.interject({
            sessionId: SessionId.of("s1"),
            branchId: BranchId.of("b1"),
            content: "interrupt-before-bind",
          }),
        )

        expect(queueExit._tag).toBe("Failure")
        expect(interjectExit._tag).toBe("Failure")
        if (queueExit._tag === "Failure") {
          expect(String(Cause.squash(queueExit.cause))).toContain(
            "called before AgentLoop bound handlers",
          )
        }
        if (interjectExit._tag === "Failure") {
          expect(String(Cause.squash(interjectExit.cause))).toContain(
            "called before AgentLoop bound handlers",
          )
        }
      }).pipe(Effect.provide(ExtensionTurnControl.Live))
    }),
  )

  it.live("Live forwards commands after handlers are bound", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([])

      yield* Effect.gen(function* () {
        const tc = yield* ExtensionTurnControl
        yield* tc.bind({
          queueFollowUp: (input) =>
            Ref.update(calls, (current) => [...current, `followUp:${input.content}`]),
          interject: (input) =>
            Ref.update(calls, (current) => [...current, `interject:${input.content}`]),
        })

        yield* tc.queueFollowUp({
          sessionId: SessionId.of("s1"),
          branchId: BranchId.of("b1"),
          content: "queued-after-bind",
        })
        yield* tc.interject({
          sessionId: SessionId.of("s1"),
          branchId: BranchId.of("b1"),
          content: "interrupt-after-bind",
        })

        expect(yield* Ref.get(calls)).toEqual([
          "followUp:queued-after-bind",
          "interject:interrupt-after-bind",
        ])
      }).pipe(Effect.provide(ExtensionTurnControl.Live))
    }),
  )
})
