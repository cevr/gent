import { describe, expect, it } from "effect-bun-test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { ResourceId, ResourceRevision } from "../../src/domain/resource-graph.js"
import {
  makeResourceLifecycle,
  type ResourceLifecycleSpec,
} from "../../src/runtime/extensions/resource-host/resource-lifecycle.js"

class TestService extends Context.Service<TestService, { readonly instance: number }>()(
  "@gent/core/tests/extensions/resource-lifecycle.test/TestService",
) {}
class ParentMarker extends Context.Service<ParentMarker, { readonly value: string }>()(
  "@gent/core/tests/extensions/resource-lifecycle.test/ParentMarker",
) {}

const resourceId = (name: string) => ResourceId.make(`test/resource-lifecycle/${name}`)
const resourceRevision = ResourceRevision.make("1")

const makeSpec = <A, E, R>(
  name: string,
  spec: Omit<ResourceLifecycleSpec<A, E, R>, "id" | "revision">,
): ResourceLifecycleSpec<A, E, R> => ({
  id: resourceId(name),
  revision: resourceRevision,
  ...spec,
})

const withTestScope = <A, E, R>(
  strategy: "sequential" | "parallel",
  use: (scope: Scope.Closeable) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireUseRelease(Scope.make(strategy), use, (scope) =>
      Scope.close(scope, Exit.void).pipe(Effect.ignore),
    ),
  )

describe("resource lifecycle", () => {
  it.live("uses one scoped service instance for start, current, stop, and release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        let nextInstance = 0
        const layer = Layer.effect(
          TestService,
          Effect.acquireRelease(
            Effect.sync(() => {
              const instance = ++nextInstance
              events.push(`acquire:${instance}`)
              return TestService.of({ instance })
            }),
            (service) => Effect.sync(() => events.push(`release:${service.instance}`)),
          ),
        )
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("same-instance", {
            layer,
            start: Effect.gen(function* () {
              const service = yield* TestService
              events.push(`start:${service.instance}`)
            }),
            stop: Effect.gen(function* () {
              const service = yield* TestService
              events.push(`stop:${service.instance}`)
            }),
          }),
        )

        yield* lifecycle.activate
        const current = yield* lifecycle.current
        expect(Option.isSome(current)).toBe(true)
        if (Option.isSome(current)) {
          expect(Context.get(current.value, TestService).instance).toBe(1)
        }
        yield* lifecycle.retire

        expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Retired" })
        expect(yield* lifecycle.current).toEqual(Option.none())
        expect(events).toEqual(["acquire:1", "start:1", "stop:1", "release:1"])
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("owns start and stop resources before releasing the layer", () =>
    withTestScope("sequential", (parentScope) =>
      Effect.gen(function* () {
        const events: Array<string> = []
        const layer = Layer.effect(
          TestService,
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("layer-acquire")
              return TestService.of({ instance: 1 })
            }),
            () => Effect.sync(() => events.push("layer-release")),
          ),
        )
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("scoped-hooks", {
            layer,
            start: Effect.acquireRelease(
              Effect.sync(() => {
                events.push("start-acquire")
              }),
              () => Effect.sync(() => events.push("start-release")),
            ),
            stop: Effect.acquireRelease(
              Effect.sync(() => {
                events.push("stop-acquire")
              }),
              () => Effect.sync(() => events.push("stop-release")),
            ),
          }),
        ).pipe(Effect.provideService(Scope.Scope, parentScope))

        yield* lifecycle.activate
        yield* lifecycle.retire

        expect(events).toEqual([
          "layer-acquire",
          "start-acquire",
          "stop-acquire",
          "stop-release",
          "start-release",
          "layer-release",
        ])
        let parentClosed = false
        yield* Scope.addFinalizer(
          parentScope,
          Effect.sync(() => {
            parentClosed = true
          }),
        )
        expect(parentClosed).toBe(false)
        yield* Scope.close(parentScope, Exit.void)
        expect(parentClosed).toBe(true)
      }).pipe(Effect.timeout("2 seconds")),
    ),
  )

  it.live("returns a typed failure when startup fails and releases the acquired layer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        const layer = Layer.effect(
          TestService,
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("acquire")
              return TestService.of({ instance: 1 })
            }),
            () => Effect.sync(() => events.push("release")),
          ),
        )
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("failed-start", {
            layer,
            start: Effect.fail("start failed"),
          }),
        )

        const result = yield* lifecycle.activate.pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Failed", phase: "start" })
        expect(events).toEqual(["acquire", "release"])
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("serializes overlapping activation and retirement commands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startEntered = yield* Deferred.make<true>()
        const releaseStart = yield* Deferred.make<true>()
        yield* Effect.gen(function* () {
          const events: Array<string> = []
          const layer = Layer.effect(
            TestService,
            Effect.acquireRelease(
              Effect.sync(() => TestService.of({ instance: 1 })),
              () => Effect.sync(() => events.push("release")),
            ),
          )
          const lifecycle = yield* makeResourceLifecycle(
            makeSpec("overlap", {
              layer,
              start: Effect.gen(function* () {
                yield* Deferred.succeed(startEntered, true)
                yield* Deferred.await(releaseStart)
                events.push("start")
              }),
              stop: Effect.sync(() => events.push("stop")),
            }),
          )

          const first = yield* lifecycle.activate.pipe(Effect.forkChild)
          yield* Deferred.await(startEntered).pipe(Effect.timeout("1 second"))
          const second = yield* lifecycle.activate.pipe(Effect.forkChild)
          const retire = yield* lifecycle.retire.pipe(Effect.forkChild)
          yield* Deferred.succeed(releaseStart, true)

          expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(retire))).toBe(true)
          expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Retired" })
          expect(events).toEqual(["start", "stop", "release"])
        }).pipe(Effect.ensuring(Deferred.succeed(releaseStart, true).pipe(Effect.asVoid)))
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("does not reacquire on duplicate commands and rejects reactivation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let acquisitions = 0
        let releases = 0
        const layer = Layer.effect(
          TestService,
          Effect.acquireRelease(
            Effect.sync(() => {
              acquisitions += 1
              return TestService.of({ instance: acquisitions })
            }),
            () =>
              Effect.sync(() => {
                releases += 1
              }),
          ),
        )
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("duplicate", {
            layer,
          }),
        )

        yield* lifecycle.activate
        yield* lifecycle.activate
        yield* lifecycle.retire
        yield* lifecycle.retire
        const reactivation = yield* lifecycle.activate.pipe(Effect.exit)

        expect(Exit.isFailure(reactivation)).toBe(true)
        expect(acquisitions).toBe(1)
        expect(releases).toBe(1)
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("reports stop and release failures after cleanup", () =>
    withTestScope("sequential", (parentScope) =>
      Effect.gen(function* () {
        const events: Array<string> = []
        const layer = Layer.effect(
          TestService,
          Effect.acquireRelease(
            Effect.sync(() => TestService.of({ instance: 1 })),
            () => Effect.die("release failed"),
          ),
        )
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("failed-stop", {
            layer,
            stop: Effect.gen(function* () {
              events.push("stop")
              return yield* Effect.fail("stop failed")
            }),
          }),
        ).pipe(Effect.provideService(Scope.Scope, parentScope))

        yield* lifecycle.activate
        const retired = yield* lifecycle.retire.pipe(Effect.exit)
        expect(Exit.isFailure(retired)).toBe(true)
        expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Failed" })
        expect(events).toEqual(["stop"])
        const closed = yield* Scope.close(parentScope, Exit.void).pipe(Effect.exit)
        expect(Exit.isFailure(closed)).toBe(true)
      }).pipe(Effect.timeout("2 seconds")),
    ),
  )

  it.live("reports a layer release defect as a release failure", () =>
    withTestScope("sequential", (parentScope) =>
      Effect.gen(function* () {
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("failed-release", {
            layer: Layer.effect(
              TestService,
              Effect.acquireRelease(Effect.succeed(TestService.of({ instance: 1 })), () =>
                Effect.die("release failed"),
              ),
            ),
          }),
        ).pipe(Effect.provideService(Scope.Scope, parentScope))

        yield* lifecycle.activate
        const retired = yield* lifecycle.retire.pipe(Effect.exit)

        expect(Exit.isFailure(retired)).toBe(true)
        expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Failed", phase: "release" })
        const closed = yield* Scope.close(parentScope, Exit.void).pipe(Effect.exit)
        expect(Exit.isFailure(closed)).toBe(true)
      }).pipe(Effect.timeout("2 seconds")),
    ),
  )

  it.live("retire from inactive is terminal and does not acquire", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let acquired = false
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("inactive-retire", {
            layer: Layer.effect(
              TestService,
              Effect.sync(() => {
                acquired = true
                return TestService.of({ instance: 1 })
              }),
            ),
          }),
        )

        yield* lifecycle.retire
        const activation = yield* lifecycle.activate.pipe(Effect.exit)
        expect(Exit.isFailure(activation)).toBe(true)
        expect(acquired).toBe(false)
        expect(yield* lifecycle.current).toEqual(Option.none())
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("supports pure layers without lifecycle effects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("pure-layer", {
            layer: Layer.succeed(TestService, TestService.of({ instance: 1 })),
          }),
        )

        yield* lifecycle.activate
        expect(Option.isSome(yield* lifecycle.current)).toBe(true)
        yield* lifecycle.retire
        expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Retired" })
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("freshens a reused layer for each lifecycle scope", () => {
    const parentLayer = Layer.succeed(ParentMarker, ParentMarker.of({ value: "parent" }))
    return Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = []
        let nextInstance = 0
        const sharedLayer = Layer.effect(
          TestService,
          Effect.gen(function* () {
            yield* ParentMarker
            return yield* Effect.acquireRelease(
              Effect.sync(() => {
                const instance = ++nextInstance
                events.push(`acquire:${instance}`)
                return TestService.of({ instance })
              }),
              (service) => Effect.sync(() => events.push(`release:${service.instance}`)),
            )
          }),
        )
        const first = yield* makeResourceLifecycle(makeSpec("fresh-first", { layer: sharedLayer }))
        const second = yield* makeResourceLifecycle(
          makeSpec("fresh-second", { layer: sharedLayer }),
        )

        yield* first.activate
        yield* second.activate
        const firstContext = yield* first.current
        const secondContext = yield* second.current
        expect(Option.isSome(firstContext)).toBe(true)
        expect(Option.isSome(secondContext)).toBe(true)
        if (Option.isSome(firstContext) && Option.isSome(secondContext)) {
          expect(Context.get(firstContext.value, TestService).instance).toBe(1)
          expect(Context.get(secondContext.value, TestService).instance).toBe(2)
        }
        yield* first.retire
        yield* second.retire
        expect(events).toEqual(["acquire:1", "acquire:2", "release:1", "release:2"])
      }),
    ).pipe(Effect.provide(parentLayer), Effect.timeout("2 seconds"))
  })

  it.live("reports a layer load failure without entering Active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failingLayer: Layer.Layer<TestService, string> = Layer.effect(
          TestService,
          Effect.fail("load failed"),
        )
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("failed-load", {
            layer: failingLayer,
          }),
        )

        const activation = yield* lifecycle.activate.pipe(Effect.exit)
        expect(Exit.isFailure(activation)).toBe(true)
        expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Failed", phase: "load" })
        expect(yield* lifecycle.current).toEqual(Option.none())
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("stops an active resource exactly once when its parent scope closes", () =>
    withTestScope("sequential", (parentScope) =>
      Effect.gen(function* () {
        const events: Array<string> = []
        const lifecycle = yield* makeResourceLifecycle(
          makeSpec("parent-close-active", {
            layer: Layer.effect(
              TestService,
              Effect.acquireRelease(
                Effect.sync(() => TestService.of({ instance: 1 })),
                () => Effect.sync(() => events.push("release")),
              ),
            ),
            stop: Effect.sync(() => events.push("stop")),
          }),
        ).pipe(Effect.provideService(Scope.Scope, parentScope))

        yield* lifecycle.activate
        const closed = yield* Scope.close(parentScope, Exit.void).pipe(Effect.exit)
        expect(Exit.isSuccess(closed)).toBe(true)
        expect(events).toEqual(["stop", "release"])
        expect(yield* lifecycle.snapshot).toMatchObject({ _tag: "Retired" })
      }).pipe(Effect.timeout("2 seconds")),
    ),
  )

  it.live("cancels a blocked load and releases its acquired layer", () =>
    withTestScope("sequential", (parentScope) =>
      Effect.gen(function* () {
        const startEntered = yield* Deferred.make<true>()
        const releaseStart = yield* Deferred.make<true>()
        yield* Effect.gen(function* () {
          const events: Array<string> = []
          const lifecycle = yield* makeResourceLifecycle(
            makeSpec("cancel-load", {
              layer: Layer.effect(
                TestService,
                Effect.acquireRelease(
                  Effect.sync(() => TestService.of({ instance: 1 })),
                  () => Effect.sync(() => events.push("release")),
                ),
              ),
              start: Effect.gen(function* () {
                yield* Deferred.succeed(startEntered, true)
                yield* Deferred.await(releaseStart)
              }),
              stop: Effect.sync(() => events.push("stop")),
            }),
          ).pipe(Effect.provideService(Scope.Scope, parentScope))

          const activation = yield* lifecycle.activate.pipe(Effect.forkChild)
          yield* Deferred.await(startEntered).pipe(Effect.timeout("1 second"))
          const closed = yield* Scope.close(parentScope, Exit.void).pipe(
            Effect.exit,
            Effect.timeout("2 seconds"),
          )
          expect(Exit.isSuccess(closed)).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(activation))).toBe(true)
          expect(events).toEqual(["release"])
        }).pipe(Effect.ensuring(Deferred.succeed(releaseStart, true).pipe(Effect.asVoid)))
      }).pipe(Effect.timeout("2 seconds")),
    ),
  )

  it.live("does not abandon cleanup when a parallel parent closes during stop", () =>
    withTestScope("parallel", (parentScope) =>
      Effect.gen(function* () {
        const stopEntered = yield* Deferred.make<true>()
        const releaseStop = yield* Deferred.make<true>()
        yield* Effect.gen(function* () {
          const events: Array<string> = []
          const lifecycle = yield* makeResourceLifecycle(
            makeSpec("cancel-stop", {
              layer: Layer.effect(
                TestService,
                Effect.acquireRelease(
                  Effect.sync(() => TestService.of({ instance: 1 })),
                  () => Effect.sync(() => events.push("release")),
                ),
              ),
              stop: Effect.gen(function* () {
                yield* Deferred.succeed(stopEntered, true)
                yield* Deferred.await(releaseStop)
                events.push("stop")
              }),
            }),
          ).pipe(Effect.provideService(Scope.Scope, parentScope))

          yield* lifecycle.activate
          const retiring = yield* lifecycle.retire.pipe(Effect.forkChild)
          yield* Deferred.await(stopEntered).pipe(Effect.timeout("1 second"))
          const closing = yield* Scope.close(parentScope, Exit.void).pipe(
            Effect.exit,
            Effect.forkChild,
          )
          const early = yield* Fiber.await(closing).pipe(Effect.timeoutOption("1 millis"))
          expect(Option.isNone(early)).toBe(true)
          yield* Deferred.succeed(releaseStop, true)

          expect(Exit.isSuccess(yield* Fiber.await(retiring))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true)
          expect(events).toEqual(["stop", "release"])
        }).pipe(Effect.ensuring(Deferred.succeed(releaseStop, true).pipe(Effect.asVoid)))
      }).pipe(Effect.timeout("2 seconds")),
    ),
  )
})
