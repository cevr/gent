/**
 * ActorHost — extension-contributed Behavior wiring.
 *
 * Verifies the path from `defineExtension({ actors })` to live actors
 * in the engine:
 *  - spawned behaviors are discoverable via their `serviceKey`
 *  - tell/ask round-trip through engine-spawned actors
 *  - host scope teardown interrupts every spawned fiber
 *  - persistence-key collisions are caught: extension still loads,
 *    the colliding actor is logged + skipped
 */

import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Ref, Schema, Scope } from "effect"
import { ActorEngine } from "@gent/core/runtime/extensions/actor-engine"
import { ActorHost } from "@gent/core/runtime/extensions/actor-host"
import { Receptionist } from "@gent/core/runtime/extensions/receptionist"
import { ServiceKey, type ActorRef, type Behavior } from "@gent/core/domain/actor"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { LoadedExtension } from "@gent/core/domain/extension"
import type { ResolvedExtensions } from "@gent/core/runtime/extensions/registry"
import { ExtensionId } from "@gent/core/domain/ids"

const PingMsg = TaggedEnumClass("PingMsg", {
  Bump: {},
  Get: {},
})
type PingMsg = Schema.Schema.Type<typeof PingMsg>

const PingState = Schema.Struct({ hits: Schema.Number })
type PingState = typeof PingState.Type

const PingService = ServiceKey<PingMsg>("ping-service")

const makePingBehavior = (persistenceKey?: string): Behavior<PingMsg, PingState, never> => ({
  initialState: { hits: 0 },
  serviceKey: PingService,
  ...(persistenceKey !== undefined
    ? { persistence: { key: persistenceKey, state: PingState } }
    : {}),
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "Bump":
          return { hits: state.hits + 1 }
        case "Get":
          yield* ctx.reply(state.hits)
          return state
      }
    }) as Effect.Effect<PingState, never, never>,
})

// Minimal LoadedExtension stub — ActorHost only reads `manifest.id`
// and `contributions.actors`, so the rest of the shape can be empty.
const makeLoaded = (
  id: string,
  actors: ReadonlyArray<Behavior<PingMsg, PingState, never>>,
): LoadedExtension =>
  ({
    manifest: { id: ExtensionId.make(id) },
    contributions: { actors },
    scope: "builtin" as const,
    sourcePath: "test",
    sealedRequirements: undefined,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub of LoadedExtension; only the fields ActorHost reads matter
  }) as unknown as LoadedExtension

const makeResolved = (extensions: ReadonlyArray<LoadedExtension>): ResolvedExtensions =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub; ActorHost only walks `extensions`
  ({ extensions }) as unknown as ResolvedExtensions

describe("ActorHost", () => {
  test("contributed Behavior is spawned and discoverable via its ServiceKey", async () => {
    const resolved = makeResolved([makeLoaded("@test/ping", [makePingBehavior()])])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const refs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(PingService)
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(refs.length).toBe(1)
  })

  test("tell + ask round-trip through host-spawned actor", async () => {
    const resolved = makeResolved([makeLoaded("@test/ping", [makePingBehavior()])])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          const ref = refs[0] as ActorRef<PingMsg>
          yield* engine.tell(ref, PingMsg.Bump.make({}))
          yield* engine.tell(ref, PingMsg.Bump.make({}))
          return yield* engine.ask<PingMsg, number>(ref, PingMsg.Get.make({}), () =>
            PingMsg.Get.make({}),
          )
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(observed).toBe(2)
  })

  test("host-scope teardown interrupts spawned actor fibers", async () => {
    // Block the spawned receive on `Effect.never`, signal via Deferred
    // when the fiber actually reaches receive, signal a second Deferred
    // via `Effect.onInterrupt` when it is interrupted. Closing the host
    // scope must fire the interrupt finalizer.
    const HoldMsg = TaggedEnumClass("HoldMsg", { Hold: {} })
    type HoldMsg = Schema.Schema.Type<typeof HoldMsg>
    const HoldKey = ServiceKey<HoldMsg>("hold-service")

    await Effect.runPromise(
      Effect.gen(function* () {
        const reachedReceive = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()

        const holdBehavior: Behavior<HoldMsg, null, never> = {
          initialState: null,
          serviceKey: HoldKey,
          receive: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reachedReceive, undefined)
              yield* Effect.never
              return null
            }).pipe(
              Effect.onInterrupt(() => Effect.asVoid(Deferred.succeed(interrupted, undefined))),
            ) as Effect.Effect<null, never, never>,
        }

        const resolved = makeResolved([
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub: ActorHost only reads `manifest.id` + `contributions.actors`
          makeLoaded("@test/hold", [
            holdBehavior as unknown as Behavior<PingMsg, PingState, never>,
          ]),
        ])
        const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

        const hostScope = yield* Scope.make()
        const ctx = yield* Layer.buildWithScope(layer, hostScope)
        const engine = Context.get(ctx, ActorEngine)
        const reg = Context.get(ctx, Receptionist)

        const refs = yield* reg.find(HoldKey)
        const ref = refs[0] as ActorRef<HoldMsg>
        yield* engine.tell(ref, HoldMsg.Hold.make({}))
        yield* Deferred.await(reachedReceive)

        yield* Scope.close(hostScope, Exit.void)

        const result = yield* Deferred.await(interrupted).pipe(Effect.timeoutOption("1 second"))
        expect(result._tag).toBe("Some")
      }),
    )
  })

  test("two extensions contributing one actor each: both reach the registry", async () => {
    const KeyA = ServiceKey<PingMsg>("ping-a")
    const KeyB = ServiceKey<PingMsg>("ping-b")
    const behaviorA: Behavior<PingMsg, PingState, never> = {
      ...makePingBehavior(),
      serviceKey: KeyA,
    }
    const behaviorB: Behavior<PingMsg, PingState, never> = {
      ...makePingBehavior(),
      serviceKey: KeyB,
    }
    const resolved = makeResolved([
      makeLoaded("@test/ping-a", [behaviorA]),
      makeLoaded("@test/ping-b", [behaviorB]),
    ])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const counts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const a = yield* reg.find(KeyA)
          const b = yield* reg.find(KeyB)
          return { a: a.length, b: b.length }
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(counts).toEqual({ a: 1, b: 1 })
  })

  test("two extensions with the same flat persistence key both spawn (host namespaces by extension id)", async () => {
    const dup = makePingBehavior("shared-key")
    // Pre-W10-0c the second spawn would collide on `shared-key`. With
    // host-level extension-id namespacing the engine sees
    // `@test/ext-1/shared-key` vs `@test/ext-2/shared-key` — distinct
    // claims, both actors live.
    const resolved = makeResolved([
      makeLoaded("@test/ext-1", [dup]),
      makeLoaded("@test/ext-2", [dup]),
    ])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const live = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          return refs.length
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(live).toBe(2)
  })

  test("same-extension persistence-key collision still fails: second actor is skipped", async () => {
    const dup = makePingBehavior("shared-key")
    // Same extension declares two behaviors with the same flat key.
    // Namespacing folds both to `@test/ext/shared-key`, so the engine's
    // collision check fires and the second one is skipped.
    const resolved = makeResolved([makeLoaded("@test/ext", [dup, dup])])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const live = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          return refs.length
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(live).toBe(1)
  })

  test("snapshot keys are extension-id-namespaced (W10-0c regression)", async () => {
    const counter = makePingBehavior("counter")
    const resolved = makeResolved([
      makeLoaded("@test/ext-a", [counter]),
      makeLoaded("@test/ext-b", [counter]),
    ])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const keys = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const snap = yield* engine.snapshot()
          return Array.from(snap.keys()).sort()
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(keys).toEqual(["@test/ext-a/counter", "@test/ext-b/counter"])
  })

  test("extension with empty actors bucket is a no-op", async () => {
    const resolved = makeResolved([makeLoaded("@test/empty", [])])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const live = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(PingService)
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(live).toEqual([])
  })

  test("multiple actors per extension all spawn", async () => {
    const counter = makePingBehavior()
    const resolved = makeResolved([
      makeLoaded("@test/a", [counter, counter]),
      makeLoaded("@test/b", [counter]),
    ])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          return refs.length
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(observed).toBe(3)
  })
})

// Defensive sanity: prove the host *uses* the engine, not a parallel
// shadow registry. If a future refactor swapped the engine for a stub,
// this test would fail because ActorEngine spawn is the only path
// that registers refs with Receptionist.
describe("ActorHost — engine integration", () => {
  test("a Behavior with no serviceKey is spawned but not registered", async () => {
    const noKey: Behavior<PingMsg, PingState, never> = {
      initialState: { hits: 0 },
      receive: (msg, state, ctx) =>
        Effect.gen(function* () {
          if (msg._tag === "Get") yield* ctx.reply(state.hits)
          return state
        }) as Effect.Effect<PingState, never, never>,
    }
    const resolved = makeResolved([makeLoaded("@test/no-key", [noKey])])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    const found = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(PingService)
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(found).toEqual([])
  })

  test("Ref-based observability — spawned actor receives messages", async () => {
    // Use a stateful Ref to confirm the spawned actor's receive loop is
    // actually running, not just registered.
    const counter = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* Ref.make(0)
          const Tick = TaggedEnumClass("Tick", { Bump: {}, Read: {} })
          type Tick = Schema.Schema.Type<typeof Tick>
          const TickKey = ServiceKey<Tick>("tick-key")
          const behavior: Behavior<Tick, { n: number }, never> = {
            initialState: { n: 0 },
            serviceKey: TickKey,
            receive: (msg, state, ctx) =>
              Effect.gen(function* () {
                switch (msg._tag) {
                  case "Bump": {
                    const next = { n: state.n + 1 }
                    yield* Ref.set(ref, next.n)
                    return next
                  }
                  case "Read":
                    yield* ctx.reply(state.n)
                    return state
                }
              }) as Effect.Effect<{ n: number }, never, never>,
          }
          const resolved = makeResolved([makeLoaded("@test/tick", [behavior])])
          const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const engine = yield* ActorEngine
              const reg = yield* Receptionist
              const refs = yield* reg.find(TickKey)
              const target = refs[0] as ActorRef<Tick>
              yield* engine.tell(target, Tick.Bump.make({}))
              yield* engine.tell(target, Tick.Bump.make({}))
              yield* engine.tell(target, Tick.Bump.make({}))
              const seen = yield* engine.ask<Tick, number>(target, Tick.Read.make({}), () =>
                Tick.Read.make({}),
              )
              return seen
            }).pipe(Effect.provide(layer)),
          )
        }),
      ),
    )
    expect(counter).toBe(3)
  })
})
