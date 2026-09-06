import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Fiber, Option, Schema, Stream } from "effect"
import {
  textStep,
  toolCallStep,
  textThenToolCallStep,
  multiToolCallStep,
} from "@gent/core-internal/debug/provider"
import {
  LanguageModelLayers,
  type SequenceStep,
} from "@gent/core-internal/test-utils/language-model"
import { convertTools } from "../../src/runtime/agent/tool-runner"
import { LanguageModel } from "effect/unstable/ai"
import type * as Response from "effect/unstable/ai/Response"
import { tool } from "@gent/core/extensions/api"

const testToolkit = convertTools([
  tool({
    id: "my_tool",
    description: "Test tool",
    params: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.Void,
    execute: () => Effect.void,
  }),
  tool({
    id: "tool_a",
    description: "Test tool A",
    params: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.Void,
    execute: () => Effect.void,
  }),
  tool({
    id: "tool_b",
    description: "Test tool B",
    params: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.Void,
    execute: () => Effect.void,
  }),
])

const callProvider = Effect.gen(function* () {
  const parts = yield* LanguageModel.streamText({
    prompt: [],
    toolkit: testToolkit,
    disableToolCallResolution: true,
  }).pipe(Stream.runCollect)
  return Array.from(parts) satisfies ReadonlyArray<Response.AnyPart>
})

describe("LanguageModelLayers.sequence", () => {
  it.scoped("single text step emits correctly", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.sequence([textStep("hello")])
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(2)
      expect(parts[0]?.type).toBe("text-delta")
      const first = Option.fromUndefinedOr(parts[0])
      expect(Option.isSome(first)).toBe(true)
      if (Option.isNone(first) || first.value.type !== "text-delta") return
      expect(first.value.delta).toBe("hello")
      expect(parts[1]?.type).toBe("finish")
      const finish = Option.fromUndefinedOr(parts[1])
      expect(Option.isSome(finish)).toBe(true)
      if (Option.isNone(finish) || finish.value.type !== "finish") return
      expect(finish.value.reason).toBe("stop")

      yield* controls.assertDone
    }),
  )

  it.scoped("multi-step returns correct parts per call", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.sequence([
        textStep("first"),
        textStep("second"),
        toolCallStep("my_tool", { key: "value" }),
      ])

      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const c1 = yield* Effect.provide(callProvider, layer)
      const first = Option.fromUndefinedOr(c1[0])
      expect(Option.isSome(first)).toBe(true)
      if (Option.isNone(first) || first.value.type !== "text-delta") return
      expect(first.value.delta).toBe("first")

      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const c2 = yield* Effect.provide(callProvider, layer)
      const second = Option.fromUndefinedOr(c2[0])
      expect(Option.isSome(second)).toBe(true)
      if (Option.isNone(second) || second.value.type !== "text-delta") return
      expect(second.value.delta).toBe("second")

      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const c3 = yield* Effect.provide(callProvider, layer)
      expect(c3[0]?.type).toBe("tool-call")

      yield* controls.assertDone
    }),
  )

  it.scoped("waitForCall resolves on model stream #n", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.sequence([
        textStep("a"),
        textStep("b"),
      ])

      // Start waiting for call 1 (hasn't happened yet)
      const fiber = yield* Effect.forkScoped(controls.waitForCall(1))

      // Call 0
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      yield* Effect.provide(callProvider, layer)

      // Call 1 — should resolve waitForCall(1)
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const streamFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))
      yield* Fiber.join(fiber)

      yield* Fiber.join(streamFiber)
    }),
  )

  it.scoped("gated step holds until emitAll", () =>
    Effect.gen(function* () {
      const gatedStep: SequenceStep = { ...textStep("gated"), gated: true }
      const { layer, controls } = yield* LanguageModelLayers.sequence([gatedStep])

      // Start stream — will block on gate
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))

      // Confirm call started
      yield* controls.waitForCall(0)

      // Release the gate
      yield* controls.emitAll(0)

      const parts = yield* Fiber.join(collectFiber)
      expect(parts.length).toBe(2)
      const first = Option.fromUndefinedOr(parts[0])
      expect(Option.isSome(first)).toBe(true)
      if (Option.isNone(first) || first.value.type !== "text-delta") return
      expect(first.value.delta).toBe("gated")
    }),
  )

  it.scoped("extra model stream call fails", () =>
    Effect.gen(function* () {
      const { layer } = yield* LanguageModelLayers.sequence([textStep("only")])

      // Consume the one step
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      yield* Effect.provide(callProvider, layer)

      // Second call should fail
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const exit = yield* Effect.exit(Effect.provide(callProvider, layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("2 times but only 1 steps")
      }
    }),
  )

  it.scoped("assertOptions fires and can fail the stream", () =>
    Effect.gen(function* () {
      const context = yield* Effect.context()
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertOptions: (options) => {
          if (options.tools.length === 3) {
            return Effect.runSyncWith(context)(Effect.die(new Error("wrong options")))
          }
        },
      }
      const { layer } = yield* LanguageModelLayers.sequence([step])

      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const exit = yield* Effect.exit(Effect.provide(callProvider, layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("wrong options")
      }
    }),
  )

  it.scoped("assertDone fails on unconsumed steps", () =>
    Effect.gen(function* () {
      const { controls } = yield* LanguageModelLayers.sequence([textStep("a"), textStep("b")])

      const result = yield* Effect.exit(controls.assertDone)
      expect(result._tag).toBe("Failure")
    }),
  )

  it.scoped("callCount tracks calls", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.sequence([
        textStep("a"),
        textStep("b"),
      ])

      expect(yield* controls.callCount).toBe(0)
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      yield* Effect.provide(callProvider, layer)
      expect(yield* controls.callCount).toBe(1)
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      yield* Effect.provide(callProvider, layer)
      expect(yield* controls.callCount).toBe(2)
    }),
  )

  it.scoped("toolCallStep emits tool-call + finish parts", () =>
    Effect.gen(function* () {
      const { layer } = yield* LanguageModelLayers.sequence([
        toolCallStep("my_tool", { status: "continue" }),
      ])
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(2)
      expect(parts[0]?.type).toBe("tool-call")
      expect(parts[1]?.type).toBe("finish")
      const finish = Option.fromUndefinedOr(parts[1])
      expect(Option.isSome(finish)).toBe(true)
      if (Option.isNone(finish) || finish.value.type !== "finish") return
      expect(finish.value.reason).toBe("tool-calls")
    }),
  )

  it.scoped("textThenToolCallStep emits text + tool call + finish", () =>
    Effect.gen(function* () {
      const { layer } = yield* LanguageModelLayers.sequence([
        textThenToolCallStep("thinking...", "my_tool", { ok: true }),
      ])
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(3)
      expect(parts[0]?.type).toBe("text-delta")
      expect(parts[1]?.type).toBe("tool-call")
      expect(parts[2]?.type).toBe("finish")
    }),
  )

  it.scoped("multiToolCallStep emits multiple tool calls + finish", () =>
    Effect.gen(function* () {
      const { layer } = yield* LanguageModelLayers.sequence([
        multiToolCallStep(
          { toolName: "tool_a", input: {} },
          { toolName: "tool_b", input: { x: 1 } },
        ),
      ])
      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts.length).toBe(3)
      expect(parts[0]?.type).toBe("tool-call")
      expect(parts[1]?.type).toBe("tool-call")
      expect(parts[2]?.type).toBe("finish")
    }),
  )
})
