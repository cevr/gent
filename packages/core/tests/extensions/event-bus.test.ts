import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { ExtensionEventBus, type BusEnvelope } from "@gent/core/runtime/extensions/event-bus"

describe("ExtensionEventBus", () => {
  const run = <A>(effect: Effect.Effect<A, never, ExtensionEventBus>) =>
    Effect.runPromise(Effect.provide(effect, ExtensionEventBus.Live))

  test("exact channel match delivers envelope", async () => {
    const received: BusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("test:hello", (env) => {
          received.push(env)
          return Effect.void
        })
        yield* bus.emit({ channel: "test:hello", payload: { msg: "hi" } })
      }),
    )
    expect(received.length).toBe(1)
    expect(received[0]!.channel).toBe("test:hello")
    expect(received[0]!.payload).toEqual({ msg: "hi" })
  })

  test("wildcard pattern matches prefix", async () => {
    const received: BusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("agent:*", (env) => {
          received.push(env)
          return Effect.void
        })
        yield* bus.emit({ channel: "agent:TaskCreated", payload: {} })
        yield* bus.emit({ channel: "agent:TaskCompleted", payload: {} })
        yield* bus.emit({ channel: "other:event", payload: {} })
      }),
    )
    expect(received.length).toBe(2)
    expect(received[0]!.channel).toBe("agent:TaskCreated")
    expect(received[1]!.channel).toBe("agent:TaskCompleted")
  })

  test("unsubscribe removes handler", async () => {
    const received: BusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        const unsub = yield* bus.on("test:channel", (env) => {
          received.push(env)
          return Effect.void
        })
        yield* bus.emit({ channel: "test:channel", payload: "first" })
        unsub()
        yield* bus.emit({ channel: "test:channel", payload: "second" })
      }),
    )
    expect(received.length).toBe(1)
    expect(received[0]!.payload).toBe("first")
  })

  test("handler errors are caught — other handlers still run", async () => {
    const received: string[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("test:multi", () => Effect.die("boom"))
        yield* bus.on("test:multi", (env) => {
          received.push(env.payload as string)
          return Effect.void
        })
        yield* bus.emit({ channel: "test:multi", payload: "hello" })
      }),
    )
    expect(received).toEqual(["hello"])
  })

  test("envelope carries sessionId and branchId", async () => {
    const received: BusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("test:ctx", (env) => {
          received.push(env)
          return Effect.void
        })
        yield* bus.emit({
          channel: "test:ctx",
          payload: null,
          sessionId: "s1" as never,
          branchId: "b1" as never,
        })
      }),
    )
    expect(received[0]!.sessionId).toBe("s1")
    expect(received[0]!.branchId).toBe("b1")
  })

  test("no match — no handlers called", async () => {
    let called = false
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("other:channel", () => {
          called = true
          return Effect.void
        })
        yield* bus.emit({ channel: "test:different", payload: {} })
      }),
    )
    expect(called).toBe(false)
  })

  test("withSubscriptions pre-registers handlers", async () => {
    const received: BusEnvelope[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.emit({ channel: "pre:registered", payload: "works" })
      }).pipe(
        Effect.provide(
          ExtensionEventBus.withSubscriptions([
            {
              pattern: "pre:registered",
              handler: (env) => {
                received.push(env as BusEnvelope)
              },
            },
          ]),
        ),
      ),
    )
    expect(received.length).toBe(1)
    expect(received[0]!.payload).toBe("works")
  })
})
