import { AgentName } from "@gent/core-internal/domain/agent"
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
import { Context, Effect, Layer, Option } from "effect"
import { buildResourceLayer } from "../../src/runtime/extensions/resource-host"
import type { AnyResourceContribution, ExtensionState } from "@gent/core-internal/domain/resource"
import { defineResource, defineStateResource } from "@gent/core-internal/domain/contribution"
import type { ScheduledJobContribution } from "@gent/core-internal/domain/scheduled-job"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { ExtensionId } from "@gent/core-internal/domain/ids"

// ── Resource shape + helpers ──

class TestServiceA extends Context.Service<TestServiceA, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-host.test/TestServiceA",
) {}
class TestServiceB extends Context.Service<TestServiceB, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-host.test/TestServiceB",
) {}
class TestCounterState extends Context.Service<TestCounterState, ExtensionState<number>>()(
  "@gent/core/tests/extensions/resource-host.test/TestCounterState",
) {}

const layerA = Layer.succeed(TestServiceA, TestServiceA.of({ value: "A" }))
const layerB = Layer.succeed(TestServiceB, TestServiceB.of({ value: "B" }))

const stubManifest = (id: string) => ({
  id: ExtensionId.make(id),
  version: "0.0.0",
})

const makeStubExtension = (
  id: string,
  resources: ReadonlyArray<AnyResourceContribution>,
): LoadedExtension =>
  ({
    manifest: stubManifest(id),
    scope: "builtin",
    sourcePath: "builtin",
    contributions: { resources },
  }) satisfies LoadedExtension

describe("defineResource", () => {
  test("emits a contribution with the declared scope", () => {
    const r = defineResource({
      id: "test/resource-host/declared-scope",
      tag: TestServiceA,
      scope: "process",
      layer: layerA,
    })
    expect(String(r.id)).toBe("test/resource-host/declared-scope")
    expect(String(r.revision)).toBe("1")
    expect(r.requires).toEqual([])
    expect(r.required).toBe(false)
    expect(r.scope).toBe("process")
    expect(r.tag).toBe(TestServiceA)
  })

  test("scheduled job contribution shape", () => {
    const job: ScheduledJobContribution = {
      id: "tick",
      cron: "0 * * * *",
      target: { agent: AgentName.make("memory:dream"), prompt: "reflect" },
    }
    expect(job.id).toBe("tick")
    expect(job.cron).toBe("0 * * * *")
  })

  test("normalizes and snapshots resource metadata", () => {
    const dependency = defineResource({
      id: "test/resource-host/metadata/dependency",
      scope: "process",
      layer: Layer.empty,
    })
    const requires = [dependency.id]
    const r = defineResource({
      id: "test/resource-host/metadata/consumer",
      revision: "2",
      requires,
      required: true,
      scope: "process",
      layer: Layer.empty,
    })
    requires.push(dependency.id)
    expect(String(r.id)).toBe("test/resource-host/metadata/consumer")
    expect(String(r.revision)).toBe("2")
    expect(r.requires).toEqual([dependency.id])
    expect(r.required).toBe(true)
  })

  test("rejects empty resource metadata", () => {
    expect(() =>
      defineResource({
        id: "",
        scope: "process",
        layer: Layer.empty,
      }),
    ).toThrow()
    expect(() =>
      defineResource({
        id: "test/resource-host/metadata/invalid-revision",
        revision: "",
        scope: "process",
        layer: Layer.empty,
      }),
    ).toThrow()
  })

  test("defineStateResource lowers scoped state to a Resource", () => {
    const r = defineStateResource({
      id: "test/resource-host/state",
      tag: TestCounterState,
      scope: "process",
      initial: 0,
    })
    expect(r.scope).toBe("process")
    expect(r.tag).toBe(TestCounterState)
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
        expect(Option.isNone(Context.getOption(ctx, TestServiceA))).toBe(true)
        expect(Option.isNone(Context.getOption(ctx, TestServiceB))).toBe(true)
      }),
    ),
  )

  it.live("merges service layers across multiple Resources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ext = makeStubExtension("ext", [
          defineResource({
            id: "test/resource-host/merge/service-a",
            scope: "process",
            layer: layerA,
          }),
          defineResource({
            id: "test/resource-host/merge/service-b",
            scope: "process",
            layer: layerB,
          }),
        ])
        const layer = buildResourceLayer([ext], "process")
        const ctx = yield* Layer.build(layer)
        expect(Context.get(ctx, TestServiceA).value).toBe("A")
        expect(Context.get(ctx, TestServiceB).value).toBe("B")
      }),
    ),
  )

  it.live("state resources provide an Effect state cell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ext = makeStubExtension("ext", [
          defineStateResource({
            id: "test/resource-host/state-layer",
            tag: TestCounterState,
            scope: "process",
            initial: Effect.succeed(1),
          }),
        ])
        const ctx = yield* Layer.build(buildResourceLayer([ext], "process"))
        const state = Context.get(ctx, TestCounterState)
        yield* state.update((current) => current + 1)
        const doubled = yield* state.modify((current) => [current * 2, current * 2])
        expect(doubled).toBe(4)
        expect(yield* state.get).toBe(4)
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
            id: "test/resource-host/lifecycle/start-stop-1",
            scope: "process",
            layer: layerA,
            start: append("start-1"),
            stop: append("stop-1"),
          }),
          defineResource({
            id: "test/resource-host/lifecycle/start-stop-2",
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
          id: "test/resource-host/lifecycle/failure/good",
          scope: "process",
          layer: layerA,
          start: append("start-good-1"),
          stop: append("stop-good-1"),
        }),
        defineResource({
          id: "test/resource-host/lifecycle/failure/bad",
          scope: "process",
          layer: layerB,
          // Intentional failure — must not bring down the layer build.
          start: Effect.die(new Error("boom")),
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
          id: "test/resource-host/lifecycle/stop-only",
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
          id: "test/resource-host/lifecycle/stop-failure/good",
          scope: "process",
          layer: layerA,
          stop: append("stop-1"),
        }),
        defineResource({
          id: "test/resource-host/lifecycle/stop-failure/bad",
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
