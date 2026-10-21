import { ExtensionContext, tool } from "@gent/core/extensions/api"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Result, Schema } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { PermitLimitMismatch, PermitName, PermitSpec, Permits } from "../../src/runtime/permits"
import {
  createE2ELayer,
  LanguageModelLayers,
  runToolWithCtx,
  testToolContext,
  waitFor,
} from "../../src/test-utils/harness"

describe("named permits", () => {
  it.scopedLive("serves queued callers before a barging arrival", () =>
    Effect.gen(function* () {
      const permits = yield* Permits
      const release = yield* Deferred.make<void>()
      const order: string[] = []
      const a = yield* permits.with("gate", 1, Deferred.await(release)).pipe(
        // Arrive after A releases but before B resumes from its grant.
        Effect.ensuring(
          Effect.gen(function* () {
            expect(order).toEqual([])
            yield* permits.with(
              "gate",
              1,
              Effect.sync(() => {
                order.push("D")
              }),
            )
          }).pipe(Effect.orDie, Effect.interruptible),
        ),
        Effect.forkScoped,
      )
      yield* waitFor(permits.list, (rows) => rows[0]?.holders.length === 1)
      const b = yield* permits
        .with(
          "gate",
          1,
          Effect.sync(() => {
            order.push("B")
          }),
        )
        .pipe(Effect.forkScoped)
      yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 1)
      const c = yield* permits
        .with(
          "gate",
          1,
          Effect.sync(() => {
            order.push("C")
          }),
        )
        .pipe(Effect.forkScoped)
      yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 2)
      yield* Deferred.done(release, Exit.void)
      yield* Effect.forEach([a, b, c], Fiber.join)
      expect(order).toEqual(["B", "C", "D"])
      expect(yield* permits.list).toEqual([])
    }).pipe(Effect.provide(Permits.Live), Effect.timeout("3 seconds")),
  )
})

it.scopedLive("admits two holders at limit two and keeps case-sensitive names independent", () =>
  Effect.gen(function* () {
    const permits = yield* Permits
    const release = yield* Deferred.make<void>()
    const a = yield* permits.with("gate", 2, Deferred.await(release)).pipe(Effect.forkScoped)
    const b = yield* permits.with("gate", 2, Deferred.await(release)).pipe(Effect.forkScoped)
    yield* waitFor(permits.list, (rows) => rows[0]?.holders.length === 2)
    const c = yield* permits.with("gate", 2, Effect.succeed("third")).pipe(Effect.forkScoped)
    const queued = yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 1)
    expect(queued[0]?.holders).toHaveLength(2)
    expect(yield* permits.with("Gate", 1, Effect.succeed("independent"))).toBe("independent")
    yield* Deferred.done(release, Exit.void)
    yield* Effect.forEach([a, b], Fiber.join)
    expect(yield* Fiber.join(c)).toBe("third")
    expect(yield* permits.list).toEqual([])
  }).pipe(Effect.provide(Permits.Live), Effect.timeout("3 seconds")),
)

describe("permit ownership", () => {
  it.scopedLive("cancels a queued waiter without blocking its successor", () =>
    Effect.gen(function* () {
      const permits = yield* Permits
      const release = yield* Deferred.make<void>()
      let ran = false
      const a = yield* permits.with("gate", 1, Deferred.await(release)).pipe(Effect.forkScoped)
      yield* waitFor(permits.list, (rows) => rows[0]?.holders.length === 1)
      const b = yield* permits
        .with(
          "gate",
          1,
          Effect.sync(() => {
            ran = true
          }),
        )
        .pipe(Effect.forkScoped)
      yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 1)
      const c = yield* permits.with("gate", 1, Effect.succeed("C")).pipe(Effect.forkScoped)
      yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 2)
      yield* Fiber.interrupt(b)
      expect((yield* permits.list)[0]?.waiters).toHaveLength(1)
      yield* Deferred.done(release, Exit.void)
      expect(yield* Fiber.join(c)).toBe("C")
      yield* Fiber.join(a)
      expect(ran).toBe(false)
      expect(yield* permits.list).toEqual([])
    }).pipe(Effect.provide(Permits.Live), Effect.timeout("3 seconds")),
  )

  it.scopedLive(
    "interrupts a reserved grant before its body and passes exactly one slot onward",
    () =>
      Effect.gen(function* () {
        const permits = yield* Permits
        const release = yield* Deferred.make<void>()
        const victim =
          yield* Deferred.make<Fiber.Fiber<void, PermitLimitMismatch | Schema.SchemaError>>()
        let ran = false
        let granted = false
        const a = yield* permits.with("gate", 1, Deferred.await(release)).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const b = yield* Deferred.await(victim)
              granted = (yield* permits.list)[0]?.holders[0]?.id === 2
              yield* Fiber.interrupt(b)
            }),
          ),
          Effect.forkScoped,
        )
        yield* waitFor(permits.list, (rows) => rows[0]?.holders.length === 1)
        const b = yield* permits
          .with(
            "gate",
            1,
            Effect.sync(() => {
              ran = true
            }),
          )
          .pipe(Effect.forkScoped)
        yield* Deferred.succeed(victim, b)
        yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 1)
        const holdC = yield* Deferred.make<void>()
        const c = yield* permits.with("gate", 1, Deferred.await(holdC)).pipe(Effect.forkScoped)
        yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 2)
        yield* Deferred.done(release, Exit.void)
        yield* Fiber.join(a)
        expect(granted).toBe(true)
        expect(ran).toBe(false)
        const interrupted = yield* Fiber.await(b)
        expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true)
        yield* waitFor(permits.list, (rows) => rows[0]?.holders[0]?.id === 3)
        const d = yield* permits.with("gate", 1, Effect.void).pipe(Effect.forkScoped)
        yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 1)
        expect((yield* permits.list)[0]?.holders).toHaveLength(1)
        yield* Deferred.done(holdC, Exit.void)
        yield* Fiber.join(c)
        yield* Fiber.join(d)
        expect(yield* permits.list).toEqual([])
      }).pipe(Effect.provide(Permits.Live), Effect.timeout("3 seconds")),
  )

  it.scopedLive(
    "rejects a live limit mismatch before the body and allows a new idle generation",
    () =>
      Effect.gen(function* () {
        const permits = yield* Permits
        const release = yield* Deferred.make<void>()
        const a = yield* permits.with("gate", 1, Deferred.await(release)).pipe(Effect.forkScoped)
        yield* waitFor(permits.list, (rows) => rows[0]?.holders.length === 1)
        let ran = false
        const result = yield* permits
          .with(
            "gate",
            2,
            Effect.sync(() => {
              ran = true
            }),
          )
          .pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toEqual(
            new PermitLimitMismatch({ permitName: "gate", limit: 1, requestedLimit: 2 }),
          )
        }
        expect(ran).toBe(false)
        yield* Deferred.done(release, Exit.void)
        yield* Fiber.join(a)
        expect(yield* permits.list).toEqual([])
        expect(yield* permits.with("gate", 2, Effect.succeed("new"))).toBe("new")
      }).pipe(Effect.provide(Permits.Live), Effect.timeout("3 seconds")),
  )

  it.scopedLive("holds capacity until inner resources close, then releases on every exit", () =>
    Effect.gen(function* () {
      const permits = yield* Permits
      const cleaning = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()
      const a = yield* permits
        .with(
          "gate",
          1,
          Effect.addFinalizer(() =>
            Deferred.done(cleaning, Exit.void).pipe(Effect.andThen(Deferred.await(cleaned))),
          ),
        )
        .pipe(Effect.forkScoped)
      // A failed assertion must still let the deliberately blocked resource close.
      yield* Effect.addFinalizer(() => Deferred.done(cleaned, Exit.void))
      yield* Deferred.await(cleaning)
      expect((yield* permits.list)[0]?.holders).toHaveLength(1)
      const b = yield* permits.with("gate", 1, Effect.succeed("next")).pipe(Effect.forkScoped)
      yield* waitFor(permits.list, (rows) => rows[0]?.waiters.length === 1)
      yield* Deferred.done(cleaned, Exit.void)
      yield* Fiber.join(a)
      expect(yield* Fiber.join(b)).toBe("next")
      yield* permits.with("gate", 1, Effect.fail("failed")).pipe(Effect.exit)
      expect(yield* permits.list).toEqual([])
      const interrupted = yield* permits.with("gate", 1, Effect.never).pipe(Effect.forkScoped)
      yield* waitFor(permits.list, (rows) => rows[0]?.holders.length === 1)
      yield* Fiber.interrupt(interrupted)
      expect(yield* permits.list).toEqual([])
    }).pipe(Effect.provide(Permits.Live), Effect.timeout("3 seconds")),
  )

  it.live("validates names and positive integer limits before entry", () =>
    Effect.gen(function* () {
      const permits = yield* Permits
      expect(Schema.is(PermitName)("A")).toBe(true)
      for (const spec of [
        { name: "", limit: 1 },
        { name: "x".repeat(257), limit: 1 },
        { name: "a", limit: 0 },
        { name: "a", limit: 1.5 },
        { name: "a", limit: Infinity },
      ]) {
        expect(Schema.is(PermitSpec)(spec)).toBe(false)
        let ran = false
        const result = yield* permits
          .with(
            spec.name,
            spec.limit,
            Effect.sync(() => {
              ran = true
            }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(ran).toBe(false)
      }
      expect(yield* permits.list).toEqual([])
    }).pipe(Effect.provide(Permits.Live)),
  )

  it.scopedLive(
    "requires an explicit service binding and gives focused tools the real limiter",
    () =>
      Effect.gen(function* () {
        expect(Option.isNone(yield* Effect.serviceOption(Permits))).toBe(true)
        const context = yield* Layer.build(Permits.Live)
        expect(context.mapUnsafe.has(Permits.key)).toBe(true)
        const root = yield* Layer.build(
          createE2ELayer({
            providerLayer: LanguageModelLayers.failing,
            extensionInputs: [],
            agents: [],
          }),
        )
        expect(root.mapUnsafe.has(Permits.key)).toBe(true)
        const ctx = testToolContext()
        const probe = tool({
          id: "permit-binding",
          description: "Inspect the focused tool root",
          params: Schema.Struct({}),
          output: Schema.Boolean,
          execute: () =>
            Effect.gen(function* () {
              const actual = yield* Effect.context<never>()
              expect(actual.mapUnsafe.has(Permits.key)).toBe(true)
              const bound = yield* Effect.serviceOption(Permits)
              const facade = (yield* ExtensionContext).Permits
              expect(Option.isSome(bound) && bound.value === facade).toBe(true)
              expect(yield* facade.with("tool", 1, facade.list)).toMatchObject([
                { name: "tool", limit: 1 },
              ])
              return true
            }),
        })
        expect(yield* runToolWithCtx(probe, {}, ctx)).toBe(true)
      }),
  )
})
