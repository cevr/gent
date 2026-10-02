import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Fiber, Schema, Stream } from "effect"
import {
  LanguageModelLayers,
  type SequenceStep,
  textStep,
  toolCallStep,
} from "../../src/test-utils/language-model"
import { convertTools } from "../../src/runtime/tools"
import { ModelResolver } from "../../src/runtime/provider"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extension-host"
import { ModelId } from "../../src/domain/agent"
import { LanguageModel } from "effect/ai"
import type * as Response from "effect/ai/Response"
import { tool } from "@gent/core/extensions/api"

// ── sequence language model ─────────────────────────────────────────────────

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
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts).toMatchObject([
        { type: "text-delta", delta: "hello" },
        { type: "finish", reason: "stop" },
      ])

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

      const c1 = yield* Effect.provide(callProvider, layer)
      expect(c1[0]).toMatchObject({ type: "text-delta", delta: "first" })

      const c2 = yield* Effect.provide(callProvider, layer)
      expect(c2[0]).toMatchObject({ type: "text-delta", delta: "second" })

      const c3 = yield* Effect.provide(callProvider, layer)
      expect(c3).toMatchObject([{ type: "tool-call" }, { type: "finish", reason: "tool-calls" }])

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
      const { layer, controls } = yield* LanguageModelLayers.sequence([gatedStep])

      // Start stream — will block on gate
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))

      // Confirm call started
      yield* controls.waitForCall(0)

      // Release the gate
      yield* controls.emitAll(0)

      const parts = yield* Fiber.join(collectFiber)
      expect(parts).toMatchObject([{ type: "text-delta", delta: "gated" }, { type: "finish" }])
    }),
  )

  it.scoped("extra model stream call fails", () =>
    Effect.gen(function* () {
      const { layer } = yield* LanguageModelLayers.sequence([textStep("only")])

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

  it.scoped("assertOptions fires and can fail the stream", () =>
    Effect.gen(function* () {
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertOptions: (options) => {
          expect(options.tools).not.toHaveLength(3)
        },
      }
      const { layer } = yield* LanguageModelLayers.sequence([step])

      const exit = yield* Effect.exit(Effect.provide(callProvider, layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("assertOptions failed at step 0")
      }
    }),
  )

  it.scoped("assertDone fails after an assertOptions failure the loop swallowed", () =>
    Effect.gen(function* () {
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertOptions: () => {
          expect("sent").toBe("expected")
        },
      }
      const { layer, controls } = yield* LanguageModelLayers.sequence([step])

      // A turn reads the failed stream as a provider error and goes on, so the
      // failure must reach the test through `assertDone`.
      yield* Effect.exit(Effect.provide(callProvider, layer))
      const done = yield* Effect.exit(controls.assertDone)
      expect(done._tag).toBe("Failure")
      if (done._tag === "Failure") {
        expect(Cause.pretty(done.cause)).toContain("assertOptions failed at step 0")
      }
    }),
  )

  it.scoped("assertDone fails after an assertRequest failure", () =>
    Effect.gen(function* () {
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertRequest: () => {
          expect("sent-model").toBe("expected-model")
        },
      }
      const { layer, controls } = yield* LanguageModelLayers.sequence([step])
      const resolve = Effect.gen(function* () {
        const resolver = yield* ModelResolver
        return yield* resolver.resolve({ modelId: ModelId.make("test/model") })
      }).pipe(
        Effect.provideService(
          ExtensionRegistry,
          ExtensionRegistry.of({
            getResolved: () => resolveExtensions([]),
            providerConfig: Effect.succeed({}),
          }),
        ),
      )

      yield* Effect.exit(Effect.provide(resolve, LanguageModelLayers.resolver(layer)))
      yield* Effect.provide(callProvider, layer)
      const done = yield* Effect.exit(controls.assertDone)
      expect(done._tag).toBe("Failure")
      if (done._tag === "Failure") {
        expect(Cause.pretty(done.cause)).toContain("assertRequest failed at step 0")
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
})

// ── signal language model ───────────────────────────────────────────────────

const callSignalProvider = LanguageModel.streamText({ prompt: [] }).pipe(Stream.runCollect)

describe("LanguageModelLayers.signal", () => {
  it.scoped("waitForStreamStart resolves once LanguageModel stream is invoked", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.signal("hi.")
      // Drain in the background — gate stays closed but the model stream is called.
      yield* Effect.forkScoped(Effect.provide(callSignalProvider, layer))
      yield* controls.waitForStreamStart
    }),
  )

  it.scoped("emitAll releases every gated chunk in order", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.signal("hi.")
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callSignalProvider, layer))
      yield* controls.waitForStreamStart
      yield* controls.emitAll
      const collected = yield* Fiber.join(collectFiber)

      // One text-delta + one finish part for "hi.".
      expect(collected.length).toBe(2)
      expect(collected[0]?.type).toBe("text-delta")
      expect(collected[1]?.type).toBe("finish")
    }),
  )
})
