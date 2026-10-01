import { describe, expect, it } from "effect-bun-test"
import { Deferred, Duration, Effect, Exit, Fiber, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeStartedMemo } from "../src/started-memo.js"

describe("started memo", () => {
  it.scopedLive("a stopped caller leaves the load's resources alive until the load ends", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const memo = yield* makeStartedMemo({
        keep: () => Duration.infinity,
        load: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(released, void 0))
            yield* Deferred.succeed(started, void 0)
            yield* Deferred.await(answer)
            return "ready"
          }),
      })
      const first = yield* Effect.forkScoped(Effect.scoped(memo.get("key")))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)
      expect(yield* Deferred.isDone(released)).toBe(false)
      yield* Deferred.succeed(answer, void 0)
      expect(yield* memo.get("key")).toBe("ready")
      expect(yield* Deferred.isDone(released)).toBe(true)
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.scopedLive("stopped callers share one load, and closing its owner stops it", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.fork(yield* Scope.Scope)
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const loads = yield* Ref.make(0)
      const memo = yield* makeStartedMemo({
        keep: () => Duration.infinity,
        load: () =>
          Effect.gen(function* () {
            yield* Ref.update(loads, (n) => n + 1)
            yield* Deferred.succeed(started, void 0)
            return yield* Effect.never
          }).pipe(Effect.ensuring(Deferred.succeed(stopped, void 0))),
      }).pipe(Effect.provideService(Scope.Scope, owner))
      const callers = yield* Effect.forEach(Array.from({ length: 16 }), () =>
        Effect.forkScoped(memo.get("key")),
      )
      yield* Deferred.await(started)
      yield* Effect.forEach(callers, Fiber.interrupt, { concurrency: 16 })
      expect(yield* Ref.get(loads)).toBe(1)
      expect(yield* Deferred.isDone(stopped)).toBe(false)
      yield* Scope.close(owner, Exit.void)
      expect(yield* Deferred.isDone(stopped)).toBe(true)
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.scopedLive("a failed load can be retried and a successful load is kept until expiry", () =>
    Effect.gen(function* () {
      const loads = yield* Ref.make(0)
      const memo = yield* makeStartedMemo({
        keep: () => Duration.seconds(5),
        load: () =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(loads, (n) => n + 1)
            if (n === 1) return yield* Effect.fail("offline")
            return n
          }),
      })
      expect(yield* Effect.flip(memo.get("key"))).toBe("offline")
      expect(yield* memo.get("key")).toBe(2)
      expect(yield* memo.get("key")).toBe(2)
      yield* TestClock.adjust("5 seconds")
      expect(yield* memo.get("key")).toBe(3)
    }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("2 seconds")),
  )
})
