import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Ref, type Scope } from "effect"
import { ToolNeeds } from "../../src/domain/tool.js"
import { ResourceManager, ResourceManagerLive } from "../../src/runtime/resource-manager.js"
const runWithResourceManager = <A, E>(effect: Effect.Effect<A, E, ResourceManager | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(ResourceManagerLive)))
describe("ResourceManager", () => {
  it.live("read needs for the same tag can overlap", () =>
    Effect.gen(function* () {
      const maxRunning = yield* Effect.promise(() =>
        runWithResourceManager(
          Effect.gen(function* () {
            const manager = yield* ResourceManager
            const running = yield* Ref.make(0)
            const max = yield* Ref.make(0)
            const bothRunning = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const read = manager.withNeeds(
              [ToolNeeds.read("fs")],
              Effect.gen(function* () {
                const now = yield* Ref.updateAndGet(running, (n) => n + 1)
                yield* Ref.update(max, (n) => Math.max(n, now))
                if (now === 2) yield* Deferred.succeed(bothRunning, undefined)
                yield* Deferred.await(release)
                yield* Ref.update(running, (n) => n - 1)
              }),
            )
            const fiber = yield* Effect.forkChild(Effect.all([read, read], { concurrency: 2 }))
            yield* Deferred.await(bothRunning).pipe(Effect.timeout("100 millis"))
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(fiber)
            return yield* Ref.get(max)
          }),
        ),
      )
      expect(maxRunning).toBe(2)
    }),
  )
  it.live("write needs exclude reads for the same tag", () =>
    Effect.gen(function* () {
      const writeStartedWhileReadHeld = yield* Effect.promise(() =>
        runWithResourceManager(
          Effect.gen(function* () {
            const manager = yield* ResourceManager
            const readStarted = yield* Deferred.make<void>()
            const releaseRead = yield* Deferred.make<void>()
            const writeStarted = yield* Deferred.make<void>()
            const readFiber = yield* Effect.forkChild(
              manager.withNeeds(
                [ToolNeeds.read("fs")],
                Effect.gen(function* () {
                  yield* Deferred.succeed(readStarted, undefined)
                  yield* Deferred.await(releaseRead)
                }),
              ),
            )
            yield* Deferred.await(readStarted)
            const writeFiber = yield* Effect.forkChild(
              manager.withNeeds(
                [ToolNeeds.write("fs")],
                Effect.gen(function* () {
                  yield* Deferred.succeed(writeStarted, undefined)
                }),
              ),
            )
            const started = yield* Deferred.await(writeStarted).pipe(
              Effect.as(true),
              Effect.timeoutOption("25 millis"),
              Effect.map((option) => option._tag === "Some"),
            )
            yield* Deferred.succeed(releaseRead, undefined)
            yield* Fiber.join(readFiber)
            yield* Fiber.join(writeFiber)
            return started
          }),
        ),
      )
      expect(writeStartedWhileReadHeld).toBe(false)
    }),
  )
  it.live("write need wins when a tool declares both read and write for one tag", () =>
    Effect.gen(function* () {
      const maxRunning = yield* Effect.promise(() =>
        runWithResourceManager(
          Effect.gen(function* () {
            const manager = yield* ResourceManager
            const running = yield* Ref.make(0)
            const max = yield* Ref.make(0)
            const run = manager.withNeeds(
              [ToolNeeds.read("fs"), ToolNeeds.write("fs")],
              Effect.gen(function* () {
                const now = yield* Ref.updateAndGet(running, (n) => n + 1)
                yield* Ref.update(max, (n) => Math.max(n, now))
                yield* Effect.sleep("5 millis")
                yield* Ref.update(running, (n) => n - 1)
              }),
            )
            yield* Effect.all([run, run], { concurrency: 2 })
            return yield* Ref.get(max)
          }),
        ),
      )
      expect(maxRunning).toBe(1)
    }),
  )
  it.live("write need wins when declared before a duplicate read need", () =>
    Effect.gen(function* () {
      const maxRunning = yield* Effect.promise(() =>
        runWithResourceManager(
          Effect.gen(function* () {
            const manager = yield* ResourceManager
            const running = yield* Ref.make(0)
            const max = yield* Ref.make(0)
            const run = manager.withNeeds(
              [ToolNeeds.write("fs"), ToolNeeds.read("fs")],
              Effect.gen(function* () {
                const now = yield* Ref.updateAndGet(running, (n) => n + 1)
                yield* Ref.update(max, (n) => Math.max(n, now))
                yield* Effect.sleep("5 millis")
                yield* Ref.update(running, (n) => n - 1)
              }),
            )
            yield* Effect.all([run, run], { concurrency: 2 })
            return yield* Ref.get(max)
          }),
        ),
      )
      expect(maxRunning).toBe(1)
    }),
  )
})
