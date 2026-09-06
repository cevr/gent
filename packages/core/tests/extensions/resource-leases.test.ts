import { describe, expect, it } from "effect-bun-test"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect"
import { ResourceGenerationId } from "../../src/domain/resource-generation.js"
import {
  makeResourceLeaseSet,
  ResourceLeaseClosedError,
  ResourceLeaseStaleGenerationError,
} from "../../src/runtime/extensions/resource-host/resource-leases.js"

const generationId = ResourceGenerationId.make("test/generation/1")

describe("resource leases", () => {
  it.live("closes admission atomically and drains repeated close calls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const leases = yield* makeResourceLeaseSet(generationId)
        const waiting = yield* leases.awaitDrained.pipe(Effect.forkChild)

        const beforeClose = yield* Fiber.await(waiting).pipe(Effect.timeoutOption("10 millis"))
        expect(Option.isNone(beforeClose)).toBe(true)

        yield* leases.closeAdmission
        yield* leases.closeAdmission
        expect(Exit.isSuccess(yield* Fiber.await(waiting))).toBe(true)

        const late = yield* leases.run(Effect.succeed("late")).pipe(Effect.exit)
        expect(Exit.isFailure(late)).toBe(true)
        if (Exit.isFailure(late)) {
          const failure = Cause.findErrorOption(late.cause)
          expect(Option.isSome(failure)).toBe(true)
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(ResourceLeaseClosedError)
            expect(failure.value.generationId).toBe(generationId)
          }
        }
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("waits for every active user before reporting drained", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const leases = yield* makeResourceLeaseSet(generationId)
        const enteredA = yield* Deferred.make<void>()
        const enteredB = yield* Deferred.make<void>()
        const releaseA = yield* Deferred.make<void>()
        const releaseB = yield* Deferred.make<void>()
        const taskA = yield* leases
          .run(Deferred.succeed(enteredA, void 0).pipe(Effect.andThen(Deferred.await(releaseA))))
          .pipe(Effect.forkChild)
        const taskB = yield* leases
          .run(Deferred.succeed(enteredB, void 0).pipe(Effect.andThen(Deferred.await(releaseB))))
          .pipe(Effect.forkChild)

        yield* Deferred.await(enteredA)
        yield* Deferred.await(enteredB)
        yield* leases.closeAdmission
        const draining = yield* leases.awaitDrained.pipe(Effect.forkChild)

        const beforeRelease = yield* Fiber.await(draining).pipe(Effect.timeoutOption("10 millis"))
        expect(Option.isNone(beforeRelease)).toBe(true)
        yield* Deferred.succeed(releaseA, void 0)
        expect(Exit.isSuccess(yield* Fiber.await(taskA))).toBe(true)
        const afterOne = yield* Fiber.await(draining).pipe(Effect.timeoutOption("10 millis"))
        expect(Option.isNone(afterOne)).toBe(true)

        yield* Deferred.succeed(releaseB, void 0)
        expect(Exit.isSuccess(yield* Fiber.await(taskB))).toBe(true)
        expect(Exit.isSuccess(yield* Fiber.await(draining))).toBe(true)
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("keeps admission until a per-use scope finalizer completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseFinalizer = yield* Deferred.make<void>()
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const leases = yield* makeResourceLeaseSet(generationId)
            const finalizerEntered = yield* Deferred.make<void>()
            const task = yield* leases
              .run(
                Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(finalizerEntered, void 0)
                    yield* Deferred.await(releaseFinalizer)
                  }),
                ),
              )
              .pipe(Effect.forkChild)

            yield* Deferred.await(finalizerEntered)
            yield* leases.closeAdmission
            const draining = yield* leases.awaitDrained.pipe(Effect.forkChild)
            const beforeFinalizer = yield* Fiber.await(draining).pipe(
              Effect.timeoutOption("10 millis"),
            )
            expect(Option.isNone(beforeFinalizer)).toBe(true)

            yield* Deferred.succeed(releaseFinalizer, void 0)
            expect(Exit.isSuccess(yield* Fiber.await(task))).toBe(true)
            expect(Exit.isSuccess(yield* Fiber.await(draining))).toBe(true)
          }),
          Deferred.succeed(releaseFinalizer, void 0).pipe(Effect.asVoid),
        )
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("cancels active work and rejects later work as stale", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const leases = yield* makeResourceLeaseSet(generationId)
        const entered = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const task = yield* leases
          .run(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, void 0)
              yield* Deferred.await(interrupted)
            }).pipe(Effect.ensuring(Deferred.succeed(interrupted, void 0).pipe(Effect.asVoid))),
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(entered)
        const cancelling = yield* leases.cancel.pipe(Effect.forkChild)
        expect(Exit.isSuccess(yield* Fiber.await(cancelling))).toBe(true)
        expect(Exit.isFailure(yield* Fiber.await(task))).toBe(true)

        const late = yield* leases.run(Effect.succeed("late")).pipe(Effect.exit)
        expect(Exit.isFailure(late)).toBe(true)
        if (Exit.isFailure(late)) {
          const failure = Cause.findErrorOption(late.cause)
          expect(Option.isSome(failure)).toBe(true)
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(ResourceLeaseStaleGenerationError)
            expect(failure.value.generationId).toBe(generationId)
          }
        }
        yield* leases.cancel
        yield* leases.closeAdmission
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("does not report cancellation until blocked finalizers complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseFinalizer = yield* Deferred.make<void>()
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const leases = yield* makeResourceLeaseSet(generationId)
            const entered = yield* Deferred.make<void>()
            const finalizerEntered = yield* Deferred.make<void>()
            const task = yield* leases
              .run(
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(finalizerEntered, void 0)
                      yield* Deferred.await(releaseFinalizer)
                    }),
                  )
                  yield* Deferred.succeed(entered, void 0)
                  return yield* Effect.never
                }),
              )
              .pipe(Effect.forkChild)

            yield* Deferred.await(entered)
            const cancelling = yield* leases.cancel.pipe(Effect.forkChild)
            yield* Deferred.await(finalizerEntered)
            const beforeFinalizer = yield* Fiber.await(cancelling).pipe(
              Effect.timeoutOption("10 millis"),
            )
            expect(Option.isNone(beforeFinalizer)).toBe(true)

            yield* Deferred.succeed(releaseFinalizer, void 0)
            expect(Exit.isSuccess(yield* Fiber.await(cancelling))).toBe(true)
            expect(Exit.isFailure(yield* Fiber.await(task))).toBe(true)
          }),
          Deferred.succeed(releaseFinalizer, void 0).pipe(Effect.asVoid),
        )
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("releases admission when the caller interrupts a use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const leases = yield* makeResourceLeaseSet(generationId)
        const entered = yield* Deferred.make<void>()
        const task = yield* leases
          .run(Deferred.succeed(entered, void 0).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild)

        yield* Deferred.await(entered)
        yield* Fiber.interrupt(task)
        expect(Exit.isFailure(yield* Fiber.await(task))).toBe(true)
        yield* leases.closeAdmission
        yield* leases.awaitDrained
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("releases admission after a failed use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const leases = yield* makeResourceLeaseSet(generationId)
        const failed = yield* leases.run(Effect.fail("boom")).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        yield* leases.closeAdmission
        yield* leases.awaitDrained
        yield* leases.closeAdmission
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

  it.live("parent scope close cancels and waits for admitted cleanup", () =>
    Effect.gen(function* () {
      const parentScope = yield* Scope.make()
      const releaseFinalizer = yield* Deferred.make<void>()
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const leases = yield* makeResourceLeaseSet(generationId).pipe(
            Effect.provideService(Scope.Scope, parentScope),
          )
          const entered = yield* Deferred.make<void>()
          const finalizerEntered = yield* Deferred.make<void>()
          const task = yield* leases
            .run(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(finalizerEntered, void 0)
                    yield* Deferred.await(releaseFinalizer)
                  }),
                )
                yield* Deferred.succeed(entered, void 0)
                return yield* Effect.never
              }),
            )
            .pipe(Effect.forkChild)

          yield* Deferred.await(entered)
          const closing = yield* Scope.close(parentScope, Exit.void).pipe(Effect.forkChild)
          yield* Deferred.await(finalizerEntered)
          const beforeFinalizer = yield* Fiber.await(closing).pipe(
            Effect.timeoutOption("10 millis"),
          )
          expect(Option.isNone(beforeFinalizer)).toBe(true)

          yield* Deferred.succeed(releaseFinalizer, void 0)
          expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.await(task))).toBe(true)
          const late = yield* leases.run(Effect.succeed("late")).pipe(Effect.exit)
          expect(Exit.isFailure(late)).toBe(true)
          if (Exit.isFailure(late)) {
            const failure = Cause.findErrorOption(late.cause)
            expect(Option.isSome(failure)).toBe(true)
            if (Option.isSome(failure)) {
              expect(failure.value).toBeInstanceOf(ResourceLeaseStaleGenerationError)
              expect(failure.value.generationId).toBe(generationId)
            }
          }
        }),
        Effect.gen(function* () {
          yield* Deferred.succeed(releaseFinalizer, void 0)
          yield* Scope.close(parentScope, Exit.void)
        }),
      )
    }).pipe(Effect.timeout("2 seconds")),
  )
})
