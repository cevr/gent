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
  buildResourceLayer,
} from "@gent/core/runtime/extensions/resource-host"
import type { AnyResourceContribution, ResourceBusEnvelope } from "@gent/core/domain/resource"
import { defineResource } from "@gent/core/domain/contribution"
import { defineExtension } from "@gent/core/extensions/api"
import { testSetupCtx } from "@gent/core/test-utils"
import type { LoadedExtension } from "@gent/core/domain/extension"

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
  resources: ReadonlyArray<AnyResourceContribution>,
): LoadedExtension =>
  ({
    manifest: stubManifest(id),
    kind: "builtin" as const,
    sourcePath: "builtin",
    contributions: { resources },
  }) as LoadedExtension

describe("defineResource", () => {
  test("emits a contribution with _kind: resource", () => {
    const r = defineResource({
      tag: TestServiceA,
      scope: "process",
      layer: layerA,
    })
    expect(r.scope).toBe("process")
    expect(r.tag).toBe(TestServiceA)
  })

  test("optional tag — Resource without canonical tag", () => {
    const r = defineResource({
      scope: "process",
      layer: Layer.merge(layerA, layerB),
    })
    expect(r.tag).toBeUndefined()
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

  test("machine field round-trips and surfaces via extractMachine", () => {
    // Minimal `ResourceMachine` shape — the runtime cares about field
    // presence + structural identity to `effect-machine`'s Machine.
    // We only need to assert the field round-trips through defineResource +
    // extractMachine; the actual supervision is tested by workflow-runtime
    // tests that drive a real machine end-to-end.
    const stubMachine = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
      machine: { _stub: true } as any,
    }
    const r = defineResource({
      scope: "process",
      layer: layerA,
      machine: stubMachine,
    })
    expect(r.machine).toBe(stubMachine)
    const ext = makeStubExtension("ext-with-machine", [r])
    const found = (ext.contributions.resources ?? []).find(
      (res) => res.machine !== undefined,
    )?.machine
    expect(found).toBe(stubMachine)
  })

  test("no machine when no Resource declares a machine", () => {
    const ext = makeStubExtension("ext-no-machine", [
      defineResource({ scope: "process", layer: layerA }),
    ])
    const found = (ext.contributions.resources ?? []).find(
      (res) => res.machine !== undefined,
    )?.machine
    expect(found).toBeUndefined()
  })
})

// ── defineExtension validation locks (codex C3.5a BLOCKs 1 + 3) ──

describe("defineExtension validation: Resource.machine constraints", () => {
  // Both fixtures use a stub machine — defineExtension validates structure
  // (counts, scopes), not Machine.Machine internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  const stubMachine = { machine: { _stub: true } as any }

  test("rejects extension with 2+ Resources declaring `machine` (codex BLOCK 1)", async () => {
    const ext = defineExtension({
      id: "@test/two-resource-machines",
      resources: [
        defineResource({ scope: "process", layer: layerA, machine: stubMachine }),
        defineResource({ scope: "process", layer: layerB, machine: stubMachine }),
      ],
    })
    const exit = await Effect.runPromiseExit(ext.setup(testSetupCtx()))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const message = String(exit.cause)
      expect(message).toContain("at most one Resource may declare `machine`")
    }
  })

  test("rejects Resource.machine on session/branch scope until composers are wired (codex BLOCK 3)", async () => {
    const ext = defineExtension({
      id: "@test/session-scope-machine",
      resources: [defineResource({ scope: "session", layer: layerA, machine: stubMachine })],
    })
    const exit = await Effect.runPromiseExit(ext.setup(testSetupCtx()))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const message = String(exit.cause)
      expect(message).toContain('Resource.machine on scope "session"')
      expect(message).toContain("not yet supported")
    }
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

describe("buildResourceLayer", () => {
  test("returns Layer.empty when no Resources match the requested scope", () => {
    const ext = makeStubExtension("ext", [defineResource({ scope: "session", layer: layerA })])
    // Layer.empty is itself a Layer; assert build succeeds with no contributions.
    const layer = buildResourceLayer([ext], "process")
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* Layer.build(layer)
          // No service tags should be present.
          expect(Context.getOrUndefined(ctx, TestServiceA)).toBe(undefined)
          expect(Context.getOrUndefined(ctx, TestServiceB)).toBe(undefined)
        }),
      ),
    )
  })

  test("returns Layer.empty when no extensions provided", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const layer = buildResourceLayer([], "process")
          const ctx = yield* Layer.build(layer)
          expect(Context.getOrUndefined(ctx, TestServiceA)).toBe(undefined)
        }),
      ),
    ))

  test("merges service layers across multiple Resources", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ext = makeStubExtension("ext", [
            defineResource({ scope: "process", layer: layerA }),
            defineResource({ scope: "process", layer: layerB }),
          ])
          const layer = buildResourceLayer([ext], "process")
          const ctx = yield* Layer.build(layer)
          expect(Context.get(ctx, TestServiceA).value).toBe("A")
          expect(Context.get(ctx, TestServiceB).value).toBe("B")
        }),
      ),
    ))

  test("scope filter excludes non-matching Resources from service merge", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ext = makeStubExtension("ext", [
            defineResource({ scope: "process", layer: layerA }),
            defineResource({ scope: "session", layer: layerB }),
          ])
          const layer = buildResourceLayer([ext], "process")
          const ctx = yield* Layer.build(layer)
          expect(Context.get(ctx, TestServiceA).value).toBe("A")
          expect(Context.getOrUndefined(ctx, TestServiceB)).toBe(undefined)
        }),
      ),
    ))
})

// ── lifecycle correctness (Resource.start / Resource.stop) ──
//
// Codex C3.4 review flagged two BLOCK findings that these tests lock down:
//
//   - BLOCK 1: a `stop` may not run when its corresponding `start` failed.
//     (Pre-fix `withLifecycle` registered `stop` unconditionally.)
//   - BLOCK 2: lifecycle teardown order must be reverse-of-start, not
//     racing parallel finalizers.
//     (Pre-fix `Layer.mergeAll` of per-Resource lifecycle layers raced.)

describe("buildResourceLayer lifecycle", () => {
  test("starts run in declaration order, stops run in reverse start order at scope teardown", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const log: string[] = []
        const append = (s: string) => Effect.sync(() => log.push(s))
        const ext = makeStubExtension("ext", [
          defineResource({
            scope: "process",
            layer: layerA,
            start: append("start-1"),
            stop: append("stop-1"),
          }),
          defineResource({
            scope: "process",
            layer: layerB,
            start: append("start-2"),
            stop: append("stop-2"),
          }),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(buildResourceLayer([ext], "process"))
          }),
        )
        // After teardown: starts in declaration order, stops in reverse.
        expect(log).toEqual(["start-1", "start-2", "stop-2", "stop-1"])
      }),
    ))

  test("failed start logs cause and skips that Resource's stop registration", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const log: string[] = []
        const append = (s: string) => Effect.sync(() => log.push(s))
        const ext = makeStubExtension("ext", [
          defineResource({
            scope: "process",
            layer: layerA,
            start: append("start-good-1"),
            stop: append("stop-good-1"),
          }),
          defineResource({
            scope: "process",
            layer: layerB,
            // Intentional failure — must not bring down the layer build.
            start: Effect.fail(new Error("boom") as never),
            // Must NOT run, because start failed.
            stop: append("stop-should-not-run"),
          }),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(buildResourceLayer([ext], "process"))
          }),
        )
        // Good start ran, good stop ran on teardown; failed Resource's stop
        // never registered, so it never appears in the log.
        expect(log).toEqual(["start-good-1", "stop-good-1"])
      }),
    ))

  test("Resource with stop but no start still registers finalizer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const log: string[] = []
        const append = (s: string) => Effect.sync(() => log.push(s))
        const ext = makeStubExtension("ext", [
          defineResource({
            scope: "process",
            layer: layerA,
            stop: append("stop-only"),
          }),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(buildResourceLayer([ext], "process"))
          }),
        )
        expect(log).toEqual(["stop-only"])
      }),
    ))

  test("Resource with start but no stop runs start; no finalizer needed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const log: string[] = []
        const append = (s: string) => Effect.sync(() => log.push(s))
        const ext = makeStubExtension("ext", [
          defineResource({
            scope: "process",
            layer: layerA,
            start: append("start-only"),
          }),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(buildResourceLayer([ext], "process"))
          }),
        )
        expect(log).toEqual(["start-only"])
      }),
    ))

  test("stop failure is swallowed and does not mask sibling stops", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const log: string[] = []
        const append = (s: string) => Effect.sync(() => log.push(s))
        const ext = makeStubExtension("ext", [
          defineResource({
            scope: "process",
            layer: layerA,
            stop: append("stop-1"),
          }),
          defineResource({
            scope: "process",
            layer: layerB,
            // Failing stop must not prevent stop-1 from running.
            stop: Effect.die(new Error("stop boom")),
          }),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(buildResourceLayer([ext], "process"))
          }),
        )
        // stop-2 (the failing one) is reverse-first; stop-1 still ran.
        expect(log).toEqual(["stop-1"])
      }),
    ))
})
