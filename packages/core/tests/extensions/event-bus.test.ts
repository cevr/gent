import { describe, it, expect } from "effect-bun-test"
import { Effect, Ref } from "effect"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"

describe("ExtensionEventBus", () => {
  it.live("emit with no listeners is a no-op", () =>
    Effect.gen(function* () {
      const bus = yield* ExtensionEventBus
      yield* bus.emit("test:channel", { value: 1 })
    }).pipe(Effect.provide(ExtensionEventBus.Live)),
  )

  it.live("on + emit delivers payload to handler", () =>
    Effect.gen(function* () {
      const bus = yield* ExtensionEventBus
      const received = yield* Ref.make<unknown[]>([])

      const handler = (payload: unknown) => Ref.update(received, (arr) => [...arr, payload])
      yield* bus.on("test:channel", handler)
      yield* bus.emit("test:channel", { value: 42 })

      const result = yield* Ref.get(received)
      expect(result).toEqual([{ value: 42 }])
    }).pipe(Effect.provide(ExtensionEventBus.Live)),
  )

  it.live("multiple listeners on same channel all receive", () =>
    Effect.gen(function* () {
      const bus = yield* ExtensionEventBus
      const log = yield* Ref.make<string[]>([])

      yield* bus.on("ch", () => Ref.update(log, (arr) => [...arr, "a"]))
      yield* bus.on("ch", () => Ref.update(log, (arr) => [...arr, "b"]))
      yield* bus.emit("ch", null)

      const result = yield* Ref.get(log)
      expect(result).toHaveLength(2)
      expect(result).toContain("a")
      expect(result).toContain("b")
    }).pipe(Effect.provide(ExtensionEventBus.Live)),
  )

  it.live("off removes handler", () =>
    Effect.gen(function* () {
      const bus = yield* ExtensionEventBus
      const count = yield* Ref.make(0)

      const handler = () => Ref.update(count, (n) => n + 1)
      yield* bus.on("ch", handler)
      yield* bus.emit("ch", null)
      yield* bus.off("ch", handler)
      yield* bus.emit("ch", null)

      const result = yield* Ref.get(count)
      expect(result).toBe(1)
    }).pipe(Effect.provide(ExtensionEventBus.Live)),
  )

  it.live("channels are isolated", () =>
    Effect.gen(function* () {
      const bus = yield* ExtensionEventBus
      const log = yield* Ref.make<string[]>([])

      yield* bus.on("a", () => Ref.update(log, (arr) => [...arr, "a"]))
      yield* bus.on("b", () => Ref.update(log, (arr) => [...arr, "b"]))
      yield* bus.emit("a", null)

      const result = yield* Ref.get(log)
      expect(result).toEqual(["a"])
    }).pipe(Effect.provide(ExtensionEventBus.Live)),
  )

  it.live("handler errors are swallowed", () =>
    Effect.gen(function* () {
      const bus = yield* ExtensionEventBus
      const received = yield* Ref.make(false)

      yield* bus.on("ch", () => Effect.die("boom"))
      yield* bus.on("ch", () => Ref.set(received, true))
      yield* bus.emit("ch", null)

      const result = yield* Ref.get(received)
      expect(result).toBe(true)
    }).pipe(Effect.provide(ExtensionEventBus.Live)),
  )
})
