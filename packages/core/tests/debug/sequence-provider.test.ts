import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Fiber, Stream } from "effect"
import {
  createSequenceProvider,
  textStep,
  toolCallStep,
  textThenToolCallStep,
  multiToolCallStep,
  type SequenceStep,
} from "@gent/core/debug/provider"
import {
  Provider,
  type FinishChunk,
  type TextChunk,
  type ProviderRequest,
} from "@gent/core/providers/provider"

const dummyRequest: ProviderRequest = {
  model: "test/model",
  messages: [],
}

const callProvider = Effect.gen(function* () {
  const provider = yield* Provider
  const stream = yield* provider.stream(dummyRequest)
  return yield* Stream.runCollect(stream)
})

describe("createSequenceProvider", () => {
  it.scoped("single text step emits correctly", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* createSequenceProvider([textStep("hello")])
      const chunks = yield* Effect.provide(callProvider, layer)

      expect(chunks.length).toBe(2)
      expect(chunks[0]!._tag).toBe("TextChunk")
      expect((chunks[0] as TextChunk).text).toBe("hello")
      expect(chunks[1]!._tag).toBe("FinishChunk")
      expect((chunks[1] as FinishChunk).finishReason).toBe("stop")

      yield* controls.assertDone()
    }),
  )

  it.scoped("multi-step returns correct chunks per call", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* createSequenceProvider([
        textStep("first"),
        textStep("second"),
        toolCallStep("my_tool", { key: "value" }),
      ])

      const c1 = yield* Effect.provide(callProvider, layer)
      expect((c1[0] as TextChunk).text).toBe("first")

      const c2 = yield* Effect.provide(callProvider, layer)
      expect((c2[0] as TextChunk).text).toBe("second")

      const c3 = yield* Effect.provide(callProvider, layer)
      expect(c3[0]!._tag).toBe("ToolCallChunk")

      yield* controls.assertDone()
    }),
  )

  it.scoped("waitForCall resolves on stream() #n", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* createSequenceProvider([textStep("a"), textStep("b")])

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
      const { layer, controls } = yield* createSequenceProvider([gatedStep])

      // Start stream — will block on gate
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))

      // Confirm call started
      yield* controls.waitForCall(0)

      // Release the gate
      yield* controls.emitAll(0)

      const chunks = yield* Fiber.join(collectFiber)
      expect(chunks.length).toBe(2)
      expect((chunks[0] as TextChunk).text).toBe("gated")
    }),
  )

  it.scoped("extra stream() call fails", () =>
    Effect.gen(function* () {
      const { layer } = yield* createSequenceProvider([textStep("only")])

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
      const { layer } = yield* createSequenceProvider([step])

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
      const { controls } = yield* createSequenceProvider([textStep("a"), textStep("b")])

      const result = yield* Effect.exit(controls.assertDone())
      expect(result._tag).toBe("Failure")
    }),
  )

  it.scoped("callCount tracks calls", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* createSequenceProvider([textStep("a"), textStep("b")])

      expect(yield* controls.callCount).toBe(0)
      yield* Effect.provide(callProvider, layer)
      expect(yield* controls.callCount).toBe(1)
      yield* Effect.provide(callProvider, layer)
      expect(yield* controls.callCount).toBe(2)
    }),
  )

  it.scoped("toolCallStep emits ToolCallChunk + FinishChunk", () =>
    Effect.gen(function* () {
      const { layer } = yield* createSequenceProvider([
        toolCallStep("my_tool", { status: "continue" }),
      ])
      const chunks = yield* Effect.provide(callProvider, layer)

      expect(chunks.length).toBe(2)
      expect(chunks[0]!._tag).toBe("ToolCallChunk")
      expect(chunks[1]!._tag).toBe("FinishChunk")
      expect((chunks[1] as FinishChunk).finishReason).toBe("tool_calls")
    }),
  )

  it.scoped("textThenToolCallStep emits text + tool call + finish", () =>
    Effect.gen(function* () {
      const { layer } = yield* createSequenceProvider([
        textThenToolCallStep("thinking...", "my_tool", { ok: true }),
      ])
      const chunks = yield* Effect.provide(callProvider, layer)

      expect(chunks.length).toBe(3)
      expect(chunks[0]!._tag).toBe("TextChunk")
      expect(chunks[1]!._tag).toBe("ToolCallChunk")
      expect(chunks[2]!._tag).toBe("FinishChunk")
    }),
  )

  it.scoped("multiToolCallStep emits multiple tool calls + finish", () =>
    Effect.gen(function* () {
      const { layer } = yield* createSequenceProvider([
        multiToolCallStep(
          { toolName: "tool_a", input: {} },
          { toolName: "tool_b", input: { x: 1 } },
        ),
      ])
      const chunks = yield* Effect.provide(callProvider, layer)

      expect(chunks.length).toBe(3)
      expect(chunks[0]!._tag).toBe("ToolCallChunk")
      expect(chunks[1]!._tag).toBe("ToolCallChunk")
      expect(chunks[2]!._tag).toBe("FinishChunk")
    }),
  )
})
