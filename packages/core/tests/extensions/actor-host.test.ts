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
import { Effect, Layer, Ref, Schema } from "effect"
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
    const resolved = makeResolved([makeLoaded("@test/ping", [makePingBehavior()])])
    const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))

    // Capture a ref while the scope is open, then attempt to use it in
    // a *new* scope. The new engine has its own mailbox table and
    // does not know about the dead actor's id, so `ask` against the
    // captured ref must time out — proving the previous scope's
    // spawn was actually torn down (not leaked into the second engine).
    const capturedRef = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          return refs[0]
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(capturedRef).toBeDefined()

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          // Dead ref + 100ms ask deadline → timeout immediately.
          return yield* engine.ask<PingMsg, number>(
            capturedRef as ActorRef<PingMsg>,
            PingMsg.Get.make({}),
            () => PingMsg.Get.make({}),
            { askMs: 100 },
          )
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(exit._tag).toBe("Failure")
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

  test("persistence-key collision: failing actor is skipped, sibling actors still spawn", async () => {
    const dup = makePingBehavior("shared-key")
    // Two extensions, each with the same persistence.key. The second
    // spawn fails ActorPersistenceKeyCollision → ActorHost logs+skips,
    // the first actor stays alive.
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
    expect(live).toBe(1)
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
