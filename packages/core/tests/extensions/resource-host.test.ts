/**
 * ResourceHost — service/lifecycle Resource tests.
 *
 * Covers:
 *   - Resource shape: defineResource produces a contribution with
 *     the typed scope literal flowing through the shape.
 *   - Resource layer assembly merges services and runs lifecycle effects.
 *   - Resource schedule metadata remains attached for the scheduler.
 *
 * @module
 */

import { describe, test, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { AgentName } from "@gent/core/domain/agent"
import { buildResourceLayer } from "../../src/runtime/extensions/resource-host"
import type { AnyResourceContribution } from "@gent/core/domain/resource"
import { defineResource } from "@gent/core/domain/contribution"
import type { LoadedExtension } from "../../src/domain/extension.js"

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
    scope: "builtin" as const,
    sourcePath: "builtin",
    contributions: { resources },
  }) as unknown as LoadedExtension

describe("defineResource", () => {
  test("emits a contribution with the declared scope", () => {
    const r = defineResource({
      tag: TestServiceA,
      scope: "process",
      layer: layerA,
    })
    expect(r.scope).toBe("process")
    expect(r.tag).toBe(TestServiceA)
  })

  test("schedule field round-trips", () => {
    const r = defineResource({
      scope: "process",
      layer: layerA,
      schedule: [
        {
          id: "tick",
          cron: "0 * * * *",
          target: { agent: AgentName.make("memory:dream"), prompt: "reflect" },
        },
      ],
    })
    expect(r.schedule).toHaveLength(1)
    expect(r.schedule![0]!.id).toBe("tick")
    expect(r.schedule![0]!.cron).toBe("0 * * * *")
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
})

// ── lifecycle correctness (Resource.start / Resource.stop) ──
//
// Codex  review flagged two BLOCK findings that these tests lock down:
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
