import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { Provider, type ModelRequest } from "@gent/core/providers/provider"
import { LanguageModel } from "effect/unstable/ai"

const dummyRequest: ModelRequest = {
  model: "test/model",
}

const callProvider = Effect.gen(function* () {
  const provider = yield* Provider
  const model = yield* provider.resolve(dummyRequest)
  return yield* LanguageModel.streamText({ prompt: [] }).pipe(
    Stream.provide(model),
    Stream.runCollect,
  )
})

describe("Provider.Signal", () => {
  it.scoped("waitForStreamStart resolves once LanguageModel stream is invoked", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* Provider.Signal("hi.")
      // Drain in the background — gate stays closed but the model stream is called.
      yield* Effect.forkScoped(Effect.provide(callProvider, layer))
      yield* controls.waitForStreamStart
    }),
  )

  it.scoped("emitAll releases every gated chunk in order", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* Provider.Signal("hi.")
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))
      yield* controls.waitForStreamStart
      yield* controls.emitAll()
      const collected = yield* Fiber.join(collectFiber)

      // One text-delta + one finish part for "hi.".
      expect(collected.length).toBe(2)
      expect(collected[0]?.type).toBe("text-delta")
      expect(collected[1]?.type).toBe("finish")
    }),
  )
})
