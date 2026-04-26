import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Fiber, Stream } from "effect"
import {
  textStep,
  toolCallStep,
  textThenToolCallStep,
  multiToolCallStep,
} from "@gent/core/debug/provider"
import { Provider, type ProviderRequest, type SequenceStep } from "@gent/core/providers/provider"

const dummyRequest: ProviderRequest = {
  model: "test/model",
  prompt: [],
}

const callProvider = Effect.gen(function* () {
  const provider = yield* Provider
  const stream = yield* provider.stream(dummyRequest)
  return yield* Stream.runCollect(stream)
})

describe("Provider.Sequence", () => {
  it.scoped("single text step emits correctly", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* Provider.Sequence([textStep("hello")])
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(2)
      expect(parts[0]?.type).toBe("text-delta")
      expect(parts[0]?.type === "text-delta" ? parts[0].delta : undefined).toBe("hello")
      expect(parts[1]?.type).toBe("finish")
      expect(parts[1]?.type === "finish" ? parts[1].reason : undefined).toBe("stop")

      yield* controls.assertDone()
    }),
  )

  it.scoped("multi-step returns correct parts per call", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* Provider.Sequence([
        textStep("first"),
        textStep("second"),
        toolCallStep("my_tool", { key: "value" }),
      ])

      const c1 = yield* Effect.provide(callProvider, layer)
      expect(c1[0]?.type === "text-delta" ? c1[0].delta : undefined).toBe("first")

      const c2 = yield* Effect.provide(callProvider, layer)
      expect(c2[0]?.type === "text-delta" ? c2[0].delta : undefined).toBe("second")

      const c3 = yield* Effect.provide(callProvider, layer)
      expect(c3[0]?.type).toBe("tool-call")

      yield* controls.assertDone()
    }),
  )

  it.scoped("waitForCall resolves on stream() #n", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* Provider.Sequence([textStep("a"), textStep("b")])

      // Start waiting for call 1 (hasn't happened yet)
      const fiber = yield* Effect.forkScoped(controls.waitForCall(1))

      // Call 0
      yield* Effect.provide(callProvider, layer)

      // Call 1 — should resolve waitForCall(1)
      const streamFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))
      yield* Fiber.join(fiber)

      yield* Fiber.join(streamFiber)
    }),
  )

  it.scoped("gated step holds until emitAll", () =>
    Effect.gen(function* () {
      const gatedStep: SequenceStep = { ...textStep("gated"), gated: true }
      const { layer, controls } = yield* Provider.Sequence([gatedStep])

      // Start stream — will block on gate
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))

      // Confirm call started
      yield* controls.waitForCall(0)

      // Release the gate
      yield* controls.emitAll(0)

      const parts = yield* Fiber.join(collectFiber)
      expect(parts.length).toBe(2)
      expect(parts[0]?.type === "text-delta" ? parts[0].delta : undefined).toBe("gated")
    }),
  )

  it.scoped("extra stream() call fails", () =>
    Effect.gen(function* () {
      const { layer } = yield* Provider.Sequence([textStep("only")])

      // Consume the one step
      yield* Effect.provide(callProvider, layer)

      // Second call should fail
      const exit = yield* Effect.exit(Effect.provide(callProvider, layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("2 times but only 1 steps")
      }
    }),
  )

  it.scoped("assertRequest fires and can fail the stream", () =>
    Effect.gen(function* () {
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertRequest: (req) => {
          if (req.model !== "expected/model") throw new Error("wrong model")
        },
      }
      const { layer } = yield* Provider.Sequence([step])

      const exit = yield* Effect.exit(Effect.provide(callProvider, layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("wrong model")
      }
    }),
  )

  it.scoped("assertDone fails on unconsumed steps", () =>
    Effect.gen(function* () {
      const { controls } = yield* Provider.Sequence([textStep("a"), textStep("b")])

      const result = yield* Effect.exit(controls.assertDone())
      expect(result._tag).toBe("Failure")
    }),
  )

  it.scoped("callCount tracks calls", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* Provider.Sequence([textStep("a"), textStep("b")])

      expect(yield* controls.callCount).toBe(0)
      yield* Effect.provide(callProvider, layer)
      expect(yield* controls.callCount).toBe(1)
      yield* Effect.provide(callProvider, layer)
      expect(yield* controls.callCount).toBe(2)
    }),
  )

  it.scoped("toolCallStep emits tool-call + finish parts", () =>
    Effect.gen(function* () {
      const { layer } = yield* Provider.Sequence([toolCallStep("my_tool", { status: "continue" })])
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(2)
      expect(parts[0]?.type).toBe("tool-call")
      expect(parts[1]?.type).toBe("finish")
      expect(parts[1]?.type === "finish" ? parts[1].reason : undefined).toBe("tool-calls")
    }),
  )

  it.scoped("textThenToolCallStep emits text + tool call + finish", () =>
    Effect.gen(function* () {
      const { layer } = yield* Provider.Sequence([
        textThenToolCallStep("thinking...", "my_tool", { ok: true }),
      ])
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(3)
      expect(parts[0]?.type).toBe("text-delta")
      expect(parts[1]?.type).toBe("tool-call")
      expect(parts[2]?.type).toBe("finish")
    }),
  )

  it.scoped("multiToolCallStep emits multiple tool calls + finish", () =>
    Effect.gen(function* () {
      const { layer } = yield* Provider.Sequence([
        multiToolCallStep(
          { toolName: "tool_a", input: {} },
          { toolName: "tool_b", input: { x: 1 } },
        ),
      ])
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(3)
      expect(parts[0]?.type).toBe("tool-call")
      expect(parts[1]?.type).toBe("tool-call")
      expect(parts[2]?.type).toBe("finish")
    }),
  )
})
