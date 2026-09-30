import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, type Path, Ref } from "effect"
import { BunServices } from "@effect/platform-bun"
import { FileLockService } from "../../src/domain/extension"
import { fileLockProbe } from "../../src/test-utils/harness"

// ── file lock ───────────────────────────────────────────────────────────────

const layer = Layer.merge(
  FileLockService.layer.pipe(Layer.provide(BunServices.layer)),
  BunServices.layer,
)

const run = <A, E>(effect: Effect.Effect<A, E, FileLockService | Path.Path>) =>
  Effect.provide(effect, layer)

describe("FileLockService", () => {
  it.live("serializes concurrent effects on same path", () =>
    run(
      Effect.gen(function* () {
        const lock = yield* FileLockService
        const order = yield* Ref.make<string[]>([])

        const task = (label: string) =>
          lock.withLock(
            "/same/path",
            Effect.gen(function* () {
              yield* Ref.update(order, (o) => [...o, `${label}-start`])
              yield* Effect.yieldNow
              yield* Ref.update(order, (o) => [...o, `${label}-end`])
            }),
          )

        // Run both concurrently using Effect.all
        yield* Effect.all([task("a"), task("b")], { concurrency: 2 })

        const result = yield* Ref.get(order)
        // With serialization: a completes fully before b starts (or vice versa)
        // Either [a-start, a-end, b-start, b-end] or [b-start, b-end, a-start, a-end]
        const aStart = result.indexOf("a-start")
        const aEnd = result.indexOf("a-end")
        const bStart = result.indexOf("b-start")
        const bEnd = result.indexOf("b-end")
        // One must fully complete before the other starts
        const aFirst = aEnd < bStart
        const bFirst = bEnd < aStart
        expect(aFirst || bFirst).toBe(true)
      }),
    ),
  )

  it.live("allows concurrent effects on different paths", () =>
    run(
      Effect.gen(function* () {
        const lock = yield* FileLockService
        const order = yield* Ref.make<string[]>([])

        const task = (label: string, path: string) =>
          lock.withLock(
            path,
            Effect.gen(function* () {
              yield* Ref.update(order, (o) => [...o, `${label}-start`])
              yield* Effect.yieldNow
              yield* Ref.update(order, (o) => [...o, `${label}-end`])
            }),
          )

        // Run on different paths concurrently
        yield* Effect.all([task("a", "/path/one"), task("b", "/path/two")], { concurrency: 2 })

        const result = yield* Ref.get(order)
        // With different paths: both should start before either ends
        expect(result.indexOf("a-start")).toBeLessThan(result.indexOf("a-end"))
        expect(result.indexOf("b-start")).toBeLessThan(result.indexOf("b-end"))
        const firstEnd = Math.min(result.indexOf("a-end"), result.indexOf("b-end"))
        expect(result.indexOf("a-start")).toBeLessThan(firstEnd)
        expect(result.indexOf("b-start")).toBeLessThan(firstEnd)
      }),
    ),
  )

  it.live("releases lock after effect completes (even on failure)", () =>
    run(
      Effect.gen(function* () {
        const lock = yield* FileLockService
        const order = yield* Ref.make<string[]>([])

        // First task fails
        yield* lock
          .withLock(
            "/fail/path",
            Effect.gen(function* () {
              yield* Ref.update(order, (o) => [...o, "fail-start"])
              return yield* Effect.fail("boom")
            }),
          )
          .pipe(Effect.ignore)

        // Second task should still acquire the lock
        yield* lock.withLock(
          "/fail/path",
          Ref.update(order, (o) => [...o, "success"]),
        )

        const result = yield* Ref.get(order)
        expect(result).toEqual(["fail-start", "success"])
      }),
    ),
  )

  it.live("the last holder's release evicts the path, so the table holds only locked paths", () =>
    Effect.gen(function* () {
      const probe = yield* fileLockProbe
      yield* Effect.gen(function* () {
        const lock = yield* FileLockService
        // 100 distinct paths, one after another: each entry leaves with its holder.
        for (let i = 0; i < 100; i++) {
          yield* lock.withLock(`/nonexistent/gent-lock/${i}`, Effect.void)
        }
        expect(yield* probe.lockedPaths).toBe(0)

        // While a holder runs, its path is in the table.
        const release = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const held = yield* Effect.forkChild(
          lock.withLock(
            "/nonexistent/gent-lock/held",
            Deferred.succeed(entered, void 0).pipe(Effect.andThen(Deferred.await(release))),
          ),
        )
        yield* Deferred.await(entered)
        expect(yield* probe.lockedPaths).toBe(1)
        yield* Deferred.succeed(release, void 0)
        yield* Fiber.join(held)
        expect(yield* probe.lockedPaths).toBe(0)

        // A holder that fails leaves too.
        yield* lock.withLock("/nonexistent/gent-lock/boom", Effect.fail("boom")).pipe(Effect.ignore)
        expect(yield* probe.lockedPaths).toBe(0)
      }).pipe(Effect.provide(Layer.provide(probe.layer, BunServices.layer)))
    }).pipe(Effect.timeout("4 seconds")),
  )
})
