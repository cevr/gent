import { describe, test, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"

const run = <A>(effect: Effect.Effect<A, never, ExtensionEventBus>) =>
  Effect.runPromise(Effect.provide(effect, ExtensionEventBus.Live))

describe("ExtensionEventBus", () => {
  test("emit with no listeners is a no-op", async () => {
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.emit("test:channel", { value: 1 })
      }),
    )
  })

  test("on + emit delivers payload to handler", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        const received = yield* Ref.make<unknown[]>([])

        const handler = (payload: unknown) => Ref.update(received, (arr) => [...arr, payload])
        yield* bus.on("test:channel", handler)
        yield* bus.emit("test:channel", { value: 42 })

        return yield* Ref.get(received)
      }),
    )
    expect(result).toEqual([{ value: 42 }])
  })

  test("multiple listeners on same channel all receive", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        const log = yield* Ref.make<string[]>([])

        yield* bus.on("ch", () => Ref.update(log, (arr) => [...arr, "a"]))
        yield* bus.on("ch", () => Ref.update(log, (arr) => [...arr, "b"]))
        yield* bus.emit("ch", null)

        return yield* Ref.get(log)
      }),
    )
    expect(result).toHaveLength(2)
    expect(result).toContain("a")
    expect(result).toContain("b")
  })

  test("off removes handler", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        const count = yield* Ref.make(0)

        const handler = () => Ref.update(count, (n) => n + 1)
        yield* bus.on("ch", handler)
        yield* bus.emit("ch", null)
        yield* bus.off("ch", handler)
        yield* bus.emit("ch", null)

        return yield* Ref.get(count)
      }),
    )
    expect(result).toBe(1)
  })

  test("channels are isolated", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        const log = yield* Ref.make<string[]>([])

        yield* bus.on("a", () => Ref.update(log, (arr) => [...arr, "a"]))
        yield* bus.on("b", () => Ref.update(log, (arr) => [...arr, "b"]))
        yield* bus.emit("a", null)

        return yield* Ref.get(log)
      }),
    )
    expect(result).toEqual(["a"])
  })

  test("handler errors are swallowed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        const received = yield* Ref.make(false)

        yield* bus.on("ch", () => Effect.die("boom"))
        yield* bus.on("ch", () => Ref.set(received, true))
        yield* bus.emit("ch", null)

        return yield* Ref.get(received)
      }),
    )
    expect(result).toBe(true)
  })
})
