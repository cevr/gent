/**
 * ResourceHost — tests for the C3.1 scaffolding.
 *
 * Covers:
 *   - SubscriptionEngine: pub/sub semantics (exact, wildcard, unsubscribe,
 *     handler error isolation, withSubscriptions pre-registration).
 *   - Resource shape: defineResource produces a contribution with
 *     `_kind: "resource"` and the typed scope literal flows through.
 *   - Helpers: collectSubscriptions, collectProcessLayers iterate the
 *     LoadedExtension surface correctly.
 *
 * Engines for lifecycle, schedule, and machine arrive in C3.3 / C3.4 /
 * C3.5 alongside their migrations; this file grows with each.
 *
 * @module
 */

import { describe, test, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import {
  SubscriptionEngine,
  collectSubscriptions,
  collectProcessLayers,
} from "@gent/core/runtime/extensions/resource-host"
import type { ResourceBusEnvelope } from "@gent/core/domain/resource"
import { defineResource } from "@gent/core/domain/contribution"
import type { LoadedExtension } from "@gent/core/domain/extension"
import type { Contribution } from "@gent/core/domain/contribution"

// ── SubscriptionEngine ──

describe("SubscriptionEngine", () => {
  const run = <A>(effect: Effect.Effect<A, never, SubscriptionEngine>) =>
    Effect.runPromise(Effect.provide(effect, SubscriptionEngine.Live))

  test("exact channel match delivers envelope", async () => {
    const received: ResourceBusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const engine = yield* SubscriptionEngine
        yield* engine.on("test:hello", (env) => {
          received.push(env)
          return Effect.void
        })
        yield* engine.emit({ channel: "test:hello", payload: { msg: "hi" } })
      }),
    )
    expect(received.length).toBe(1)
    expect(received[0]!.channel).toBe("test:hello")
    expect(received[0]!.payload).toEqual({ msg: "hi" })
  })

  test("wildcard pattern matches prefix", async () => {
    const received: ResourceBusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const engine = yield* SubscriptionEngine
        yield* engine.on("agent:*", (env) => {
          received.push(env)
          return Effect.void
        })
        yield* engine.emit({ channel: "agent:TaskCreated", payload: {} })
        yield* engine.emit({ channel: "agent:TaskCompleted", payload: {} })
        yield* engine.emit({ channel: "other:event", payload: {} })
      }),
    )
    expect(received.length).toBe(2)
    expect(received[0]!.channel).toBe("agent:TaskCreated")
    expect(received[1]!.channel).toBe("agent:TaskCompleted")
  })

  test("unsubscribe removes handler", async () => {
    const received: ResourceBusEnvelope[] = []
    await run(
      Effect.gen(function* () {
        const engine = yield* SubscriptionEngine
        const unsub = yield* engine.on("test:channel", (env) => {
          received.push(env)
          return Effect.void
        })
        yield* engine.emit({ channel: "test:channel", payload: "first" })
        unsub()
        yield* engine.emit({ channel: "test:channel", payload: "second" })
      }),
    )
    expect(received.length).toBe(1)
    expect(received[0]!.payload).toBe("first")
  })

  test("handler errors are caught — other handlers still run", async () => {
    const received: string[] = []
    await run(
      Effect.gen(function* () {
        const engine = yield* SubscriptionEngine
        yield* engine.on("test:multi", () => Effect.die("boom"))
        yield* engine.on("test:multi", (env) => {
          received.push(env.payload as string)
          return Effect.void
        })
        yield* engine.emit({ channel: "test:multi", payload: "hello" })
      }),
    )
    expect(received).toEqual(["hello"])
  })

  test("no match — no handlers called", async () => {
    let called = false
    await run(
      Effect.gen(function* () {
        const engine = yield* SubscriptionEngine
        yield* engine.on("other:channel", () => {
          called = true
          return Effect.void
        })
        yield* engine.emit({ channel: "test:different", payload: {} })
      }),
    )
    expect(called).toBe(false)
  })

  test("withSubscriptions pre-registers handlers", async () => {
    const received: ResourceBusEnvelope[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* SubscriptionEngine
        yield* engine.emit({ channel: "pre:registered", payload: "works" })
      }).pipe(
        Effect.provide(
          SubscriptionEngine.withSubscriptions([
            {
              pattern: "pre:registered",
              handler: (env) =>
                Effect.sync(() => {
                  received.push(env)
                }),
            },
          ]),
        ),
      ),
    )
    expect(received.length).toBe(1)
    expect(received[0]!.payload).toBe("works")
  })
})

// ── Resource shape + helpers ──

class TestServiceA extends Context.Service<TestServiceA, { readonly value: string }>()(
  "@test/ResourceHostTest/A",
) {}
class TestServiceB extends Context.Service<TestServiceB, { readonly value: string }>()(
  "@test/ResourceHostTest/B",
) {}

const layerA = Layer.succeed(TestServiceA, { value: "A" })
const layerB = Layer.succeed(TestServiceB, { value: "B" })

const stubManifest = (id: string) => ({
  id,
  version: "0.0.0" as const,
  description: "test",
  scope: "builtin" as const,
})

const makeStubExtension = (
  id: string,
  contributions: ReadonlyArray<Contribution>,
): LoadedExtension =>
  ({
    manifest: stubManifest(id),
    kind: "builtin" as const,
    sourcePath: "builtin",
    contributions,
  }) as LoadedExtension

describe("defineResource", () => {
  test("emits a contribution with _kind: resource", () => {
    const r = defineResource({
      tag: TestServiceA,
      scope: "process",
      layer: layerA,
    })
    expect(r._kind).toBe("resource")
    expect(r.scope).toBe("process")
    expect(r.tag).toBe(TestServiceA)
  })

  test("optional tag — Resource without canonical tag", () => {
    const r = defineResource({
      scope: "process",
      layer: Layer.merge(layerA, layerB),
    })
    expect(r.tag).toBeUndefined()
    expect(r._kind).toBe("resource")
  })

  test("subscriptions field round-trips", () => {
    const subscription = {
      pattern: "test:*",
      handler: (_env: ResourceBusEnvelope) => Effect.void,
    }
    const r = defineResource({
      scope: "process",
      layer: layerA,
      subscriptions: [subscription],
    })
    expect(r.subscriptions).toHaveLength(1)
    expect(r.subscriptions![0]!.pattern).toBe("test:*")
  })

  test("schedule field round-trips", () => {
    const r = defineResource({
      scope: "process",
      layer: layerA,
      schedule: [
        {
          id: "tick",
          cron: "0 * * * *",
          target: { kind: "headless-agent", agent: "memory:dream", prompt: "reflect" },
        },
      ],
    })
    expect(r.schedule).toHaveLength(1)
    expect(r.schedule![0]!.id).toBe("tick")
    expect(r.schedule![0]!.cron).toBe("0 * * * *")
  })
})

describe("collectSubscriptions", () => {
  test("flattens subscriptions across extensions", () => {
    const ext1 = makeStubExtension("ext1", [
      defineResource({
        scope: "process",
        layer: layerA,
        subscriptions: [
          { pattern: "a:*", handler: () => Effect.void },
          { pattern: "a:exact", handler: () => Effect.void },
        ],
      }),
    ])
    const ext2 = makeStubExtension("ext2", [
      defineResource({
        scope: "process",
        layer: layerB,
        subscriptions: [{ pattern: "b:*", handler: () => Effect.void }],
      }),
    ])
    const subs = collectSubscriptions([ext1, ext2])
    expect(subs).toHaveLength(3)
    expect(subs.map((s) => s.pattern).sort()).toEqual(["a:*", "a:exact", "b:*"])
  })

  test("empty when no Resources have subscriptions", () => {
    const ext = makeStubExtension("ext", [defineResource({ scope: "process", layer: layerA })])
    expect(collectSubscriptions([ext])).toEqual([])
  })

  test("empty when no extensions provided", () => {
    expect(collectSubscriptions([])).toEqual([])
  })

  test("default scope filter is process — non-process subscriptions excluded", () => {
    const ext = makeStubExtension("ext", [
      defineResource({
        scope: "process",
        layer: layerA,
        subscriptions: [{ pattern: "p:exact", handler: () => Effect.void }],
      }),
      defineResource({
        scope: "session",
        layer: layerB,
        subscriptions: [{ pattern: "s:exact", handler: () => Effect.void }],
      }),
    ])
    const subs = collectSubscriptions([ext])
    expect(subs.map((s) => s.pattern)).toEqual(["p:exact"])
  })

  test("explicit scopes filter — request session/branch only", () => {
    const ext = makeStubExtension("ext", [
      defineResource({
        scope: "process",
        layer: layerA,
        subscriptions: [{ pattern: "p:exact", handler: () => Effect.void }],
      }),
      defineResource({
        scope: "session",
        layer: layerB,
        subscriptions: [{ pattern: "s:exact", handler: () => Effect.void }],
      }),
    ])
    const subs = collectSubscriptions([ext], ["session", "branch"])
    expect(subs.map((s) => s.pattern)).toEqual(["s:exact"])
  })
})

describe("collectProcessLayers", () => {
  test("collects only process-scope Resource layers", () => {
    const ext = makeStubExtension("ext", [
      defineResource({ scope: "process", layer: layerA }),
      defineResource({ scope: "session", layer: layerB }),
    ])
    const layers = collectProcessLayers([ext])
    expect(layers).toHaveLength(1)
  })

  test("empty when no process-scope Resources", () => {
    const ext = makeStubExtension("ext", [defineResource({ scope: "session", layer: layerA })])
    expect(collectProcessLayers([ext])).toEqual([])
  })

  test("empty when no extensions provided", () => {
    expect(collectProcessLayers([])).toEqual([])
  })
})
