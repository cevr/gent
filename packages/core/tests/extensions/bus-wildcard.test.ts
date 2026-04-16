/**
 * Bus wildcard pattern regression locks.
 *
 * Locks the dispatch contract for `ExtensionEventBus`:
 *  - exact channel match dispatches once per matching subscription
 *  - `"prefix:*"` wildcard matches any channel starting with `"prefix:"`
 *  - non-matching channels do NOT receive envelopes
 *  - exact + wildcard subscriptions both fire when both match
 *  - one handler's failure does NOT stop sibling handlers (per-handler isolation)
 *
 * Tied to planify Commit 1 — the Contribution[] substrate registers bus subscriptions
 * via the same ExtensionEventBus. Later commits depending on bus dispatch (workflows in
 * Commit 8, projection emit in Commit 5/6) rely on this contract.
 */
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { ExtensionEventBus, type BusEnvelope } from "@gent/core/runtime/extensions/event-bus"

const run = <A>(effect: Effect.Effect<A, never, ExtensionEventBus>) =>
  Effect.runPromise(Effect.provide(effect, ExtensionEventBus.Live))

describe("bus wildcard locks", () => {
  test("exact channel match: one subscription, one delivery", async () => {
    const received: BusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("ext:hello", (env) => Effect.sync(() => received.push(env)))
        yield* bus.emit({ channel: "ext:hello", payload: 1 })
        yield* bus.emit({ channel: "ext:other", payload: 2 })
      }),
    )
    expect(received).toEqual([{ channel: "ext:hello", payload: 1 }])
  })

  test("wildcard prefix matches any colon-suffixed channel", async () => {
    const received: string[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("agent:*", (env) => Effect.sync(() => received.push(env.channel)))
        yield* bus.emit({ channel: "agent:TaskCreated", payload: {} })
        yield* bus.emit({ channel: "agent:TaskCompleted", payload: {} })
        yield* bus.emit({ channel: "ext:NotAgent", payload: {} })
      }),
    )
    expect(received).toEqual(["agent:TaskCreated", "agent:TaskCompleted"])
  })

  test("exact + wildcard both fire when both match", async () => {
    const received: string[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("agent:*", () => Effect.sync(() => received.push("wildcard")))
        yield* bus.on("agent:Hit", () => Effect.sync(() => received.push("exact")))
        yield* bus.emit({ channel: "agent:Hit", payload: {} })
      }),
    )
    expect(received.sort()).toEqual(["exact", "wildcard"])
  })

  test("handler failure does not stop sibling handlers", async () => {
    const received: string[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        yield* bus.on("ext:msg", () => Effect.fail(new Error("first blew up")))
        yield* bus.on("ext:msg", () => Effect.sync(() => received.push("second-ran")))
        yield* bus.emit({ channel: "ext:msg", payload: {} })
      }),
    )
    expect(received).toEqual(["second-ran"])
  })

  test("unsubscribe removes only that handler", async () => {
    const received: string[] = []
    await run(
      Effect.gen(function* () {
        const bus = yield* ExtensionEventBus
        const offA = yield* bus.on("ext:msg", () => Effect.sync(() => received.push("a")))
        yield* bus.on("ext:msg", () => Effect.sync(() => received.push("b")))
        yield* bus.emit({ channel: "ext:msg", payload: {} })
        offA()
        yield* bus.emit({ channel: "ext:msg", payload: {} })
      }),
    )
    expect(received).toEqual(["a", "b", "b"])
  })
})
