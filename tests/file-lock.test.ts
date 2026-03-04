import { describe, test, expect } from "bun:test"
import { Effect, Ref, Layer, type Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { FileLockService } from "@gent/core"

const layer = Layer.merge(
  FileLockService.layer.pipe(Layer.provide(BunServices.layer)),
  BunServices.layer,
)

const run = <A, E>(effect: Effect.Effect<A, E, FileLockService | Path.Path>) =>
  Effect.runPromise(Effect.provide(effect, layer))

describe("FileLockService", () => {
  test("serializes concurrent effects on same path", () =>
    run(
      Effect.gen(function* () {
        const lock = yield* FileLockService
        const order = yield* Ref.make<string[]>([])

        const task = (label: string) =>
          lock.withLock(
            "/same/path",
            Effect.gen(function* () {
              yield* Ref.update(order, (o) => [...o, `${label}-start`])
              yield* Effect.sleep("10 millis")
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
    ))

  test("allows concurrent effects on different paths", () =>
    run(
      Effect.gen(function* () {
        const lock = yield* FileLockService
        const order = yield* Ref.make<string[]>([])

        const task = (label: string, path: string) =>
          lock.withLock(
            path,
            Effect.gen(function* () {
              yield* Ref.update(order, (o) => [...o, `${label}-start`])
              yield* Effect.sleep("10 millis")
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
    ))

  test("releases lock after effect completes (even on failure)", () =>
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
              return yield* Effect.fail("boom" as const)
            }),
          )
          .pipe(Effect.catch(() => Effect.void))

        // Second task should still acquire the lock
        yield* lock.withLock(
          "/fail/path",
          Ref.update(order, (o) => [...o, "success"]),
        )

        const result = yield* Ref.get(order)
        expect(result).toEqual(["fail-start", "success"])
      }),
    ))
})
