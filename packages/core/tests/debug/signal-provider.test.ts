import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Stream } from "effect"
import { Provider, type ProviderRequest } from "@gent/core/providers/provider"

const dummyRequest: ProviderRequest = {
  model: "test/model",
  prompt: [],
}

const callProvider = Effect.gen(function* () {
  const provider = yield* Provider
  const stream = yield* provider.stream(dummyRequest)
  return yield* Stream.runCollect(stream)
})

describe("Provider.Signal", () => {
  it.scoped("waitForStreamStart resolves once stream() is invoked", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* Provider.Signal("hi.")
      // Drain in the background — gate stays closed but stream() is called.
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
