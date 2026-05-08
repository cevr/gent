/**
 * ResourceHost — service/lifecycle Resource tests.
 *
 * Covers:
 *   - Resource shape: defineResource produces a contribution with
 *     the typed scope literal flowing through the shape.
 *   - Resource layer assembly merges services and runs lifecycle effects.
 *   - Scheduled jobs are their own contribution shape, not Resource metadata.
 *
 * @module
 */

import { describe, expect, it, test } from "effect-bun-test"
import { Context, Effect, Layer } from "effect"
import { buildResourceLayer } from "../../src/runtime/extensions/resource-host"
import type { AnyResourceContribution } from "@gent/core-internal/domain/resource"
import { defineResource, defineScheduledJob } from "@gent/core-internal/domain/contribution"
import type { LoadedExtension } from "../../src/domain/extension.js"

// ── Resource shape + helpers ──

class TestServiceA extends Context.Service<TestServiceA, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-host.test/TestServiceA",
) {}
class TestServiceB extends Context.Service<TestServiceB, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-host.test/TestServiceB",
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

  test("scheduled job contribution round-trips", () => {
    const job = defineScheduledJob({
      id: "tick",
      cron: "0 * * * *",
      target: { agent: "memory:dream" as never, prompt: "reflect" },
    })
    expect(job.id).toBe("tick")
    expect(job.cron).toBe("0 * * * *")
  })
})

describe("buildResourceLayer", () => {
  it.live("returns Layer.empty when an extension has no Resources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ext = makeStubExtension("ext", [])
        const layer = buildResourceLayer([ext], "process")
        const ctx = yield* Layer.build(layer)
        // No service tags should be present.
        expect(Context.getOrUndefined(ctx, TestServiceA)).toBe(undefined)
        expect(Context.getOrUndefined(ctx, TestServiceB)).toBe(undefined)
      }),
    ),
  )

  it.live("merges service layers across multiple Resources", () =>
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
  )
})

// ── lifecycle correctness (Resource.start / Resource.stop) ──
//
// Codex  review flagged two BLOCK findings that these tests lock down:
//
//   - BLOCK 1: a failed `start` must fail the Resource layer instead of
//     leaving dependent extension contributions active.
//   - BLOCK 2: lifecycle teardown order must be reverse-of-start, not
//     racing parallel finalizers.
//     (Pre-fix `Layer.mergeAll` of per-Resource lifecycle layers raced.)

describe("buildResourceLayer lifecycle", () => {
  it.live(
    "starts run in declaration order, stops run in reverse start order at scope teardown",
    () =>
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
        yield* Effect.scoped(Layer.build(buildResourceLayer([ext], "process")))
        // After teardown: starts in declaration order, stops in reverse.
        expect(log).toEqual(["start-1", "start-2", "stop-2", "stop-1"])
      }),
  )

  it.live("failed start fails the layer and stops previously started Resources", () =>
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
      const exit = yield* Effect.scoped(Layer.build(buildResourceLayer([ext], "process"))).pipe(
        Effect.exit,
      )
      expect(exit._tag).toBe("Failure")
      // Good start ran, its stop ran on failure teardown; failed Resource's
      // stop never registered, so it never appears in the log.
      expect(log).toEqual(["start-good-1", "stop-good-1"])
    }),
  )

  it.live("Resource with stop but no start still registers finalizer", () =>
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
      yield* Effect.scoped(Layer.build(buildResourceLayer([ext], "process")))
      expect(log).toEqual(["stop-only"])
    }),
  )

  it.live("stop failure is swallowed and does not mask sibling stops", () =>
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
      yield* Effect.scoped(Layer.build(buildResourceLayer([ext], "process")))
      // stop-2 (the failing one) is reverse-first; stop-1 still ran.
      expect(log).toEqual(["stop-1"])
    }),
  )
})
