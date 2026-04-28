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
import { describe, expect, test, it } from "effect-bun-test"
import { Context, Deferred, Duration, Effect, Exit, Layer, Ref, Schema, Scope } from "effect"
import { ActorEngine } from "@gent/core/runtime/extensions/actor-engine"
import {
  ActorHost,
  ActorHostFailures,
  namespacePersistenceKey,
  parseNamespacedPersistenceKey,
} from "@gent/core/runtime/extensions/actor-host"
import { Receptionist } from "@gent/core/runtime/extensions/receptionist"
import { ServiceKey, type ActorRef, type Behavior } from "@gent/core/domain/actor"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ResolvedExtensions } from "@gent/core/runtime/extensions/registry"
import { ExtensionId } from "@gent/core/domain/ids"
import { Storage, StorageError } from "@gent/core/storage/sqlite-storage"
import {
  ActorPersistenceStorage,
  type ActorPersistenceStorageService,
} from "@gent/core/storage/actor-persistence-storage"
const PingMsg = TaggedEnumClass("PingMsg", {
  Bump: {},
  Get: TaggedEnumClass.askVariant<number>()({}),
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
  it.live("contributed Behavior is spawned and discoverable via its ServiceKey", () =>
    Effect.gen(function* () {
      const resolved = makeResolved([makeLoaded("@test/ping", [makePingBehavior()])])
      const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
      const refs = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(PingService)
        }).pipe(Effect.provide(layer)),
      )
      expect(refs.length).toBe(1)
    }),
  )
  it.live("tell + ask round-trip through host-spawned actor", () =>
    Effect.gen(function* () {
      const resolved = makeResolved([makeLoaded("@test/ping", [makePingBehavior()])])
      const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          const ref = refs[0] as ActorRef<PingMsg>
          yield* engine.tell(ref, PingMsg.Bump.make({}))
          yield* engine.tell(ref, PingMsg.Bump.make({}))
          return yield* engine.ask(ref, PingMsg.Get.make({}))
        }).pipe(Effect.provide(layer)),
      )
      expect(observed).toBe(2)
    }),
  )
  it.live("host-scope teardown interrupts spawned actor fibers", () =>
    Effect.gen(function* () {
      // Block the spawned receive on `Effect.never`, signal via Deferred
      // when the fiber actually reaches receive, signal a second Deferred
      // via `Effect.onInterrupt` when it is interrupted. Closing the host
      // scope must fire the interrupt finalizer.
      const HoldMsg = TaggedEnumClass("HoldMsg", { Hold: {} })
      type HoldMsg = Schema.Schema.Type<typeof HoldMsg>
      const HoldKey = ServiceKey<HoldMsg>("hold-service")
      yield* Effect.gen(function* () {
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
      })
    }),
  )
  it.live("two extensions contributing one actor each: both reach the registry", () =>
    Effect.gen(function* () {
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
      const counts = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const a = yield* reg.find(KeyA)
          const b = yield* reg.find(KeyB)
          return { a: a.length, b: b.length }
        }).pipe(Effect.provide(layer)),
      )
      expect(counts).toEqual({ a: 1, b: 1 })
    }),
  )
  it.live(
    "two extensions with the same flat persistence key both spawn (host namespaces by extension id)",
    () =>
      Effect.gen(function* () {
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
        const live = yield* Effect.scoped(
          Effect.gen(function* () {
            const reg = yield* Receptionist
            const refs = yield* reg.find(PingService)
            return refs.length
          }).pipe(Effect.provide(layer)),
        )
        expect(live).toBe(2)
      }),
  )
  it.live("same-extension persistence-key collision still fails: second actor is skipped", () =>
    Effect.gen(function* () {
      const dup = makePingBehavior("shared-key")
      // Same extension declares two behaviors with the same flat key.
      // Namespacing folds both to `@test/ext/shared-key`, so the engine's
      // collision check fires and the second one is skipped.
      const resolved = makeResolved([makeLoaded("@test/ext", [dup, dup])])
      const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
      const live = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          return refs.length
        }).pipe(Effect.provide(layer)),
      )
      expect(live).toBe(1)
    }),
  )
  it.live("snapshot keys are extension-id-namespaced (W10-0c regression)", () =>
    Effect.gen(function* () {
      const counter = makePingBehavior("counter")
      // Using scoped extension ids that contain `/` proves the encoding
      // is unambiguous — a `/`-based separator would alias these against
      // any behavior key with a `/` in it. Splitting `@test/ext-a` vs
      // `@test/ext-a\x1fcounter` on the unit-separator yields exactly
      // `("@test/ext-a", "counter")`.
      const resolved = makeResolved([
        makeLoaded("@test/ext-a", [counter]),
        makeLoaded("@test/ext-b", [counter]),
      ])
      const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
      const keys = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const snap = yield* engine.snapshot()
          return Array.from(snap.keys()).sort()
        }).pipe(Effect.provide(layer)),
      )
      expect(keys).toEqual(["@test/ext-a\x1fcounter", "@test/ext-b\x1fcounter"])
    }),
  )
  test("parseNamespacedPersistenceKey round-trips with scoped extension ids", () => {
    // Scoped ids with `/` were the case a printable separator would
    // break. Confirm the unit-separator encoding splits exactly once
    // at the right boundary.
    const ns = namespacePersistenceKey("@gent/memory", "todos")
    expect(parseNamespacedPersistenceKey(ns)).toEqual({
      extensionId: ExtensionId.make("@gent/memory"),
      behaviorKey: "todos",
    })
    // Behavior keys with `/` survive too — the separator is the unit
    // separator, not `/`.
    const nested = namespacePersistenceKey("@gent/memory", "todo/lists")
    expect(parseNamespacedPersistenceKey(nested)).toEqual({
      extensionId: ExtensionId.make("@gent/memory"),
      behaviorKey: "todo/lists",
    })
    // Malformed input (no separator) returns undefined.
    expect(parseNamespacedPersistenceKey("flat-key")).toBeUndefined()
  })
  it.live("fromResolvedWithPersistence round-trips state across host scopes", () =>
    Effect.gen(function* () {
      // First wave: spawn, drive a few tells, snapshot via the periodic
      // writer (writeInterval of 1ms guarantees the loop runs at least
      // once before scope close), tear down the host scope.
      // Second wave: rebuild with the SAME storage layer + same profileId.
      // The actor's `restoredState` must be the encoded post-state from
      // wave 1, so a fresh `Get` ask returns the accumulated hits — proving
      // both load AND save halves of the wire-up actually run end-to-end.
      const profileId = "test-profile"
      const persistedBehavior = makePingBehavior("counter")
      const resolved = makeResolved([makeLoaded("@test/persist", [persistedBehavior])])
      const storageLayer = Storage.MemoryWithSql()
      yield* Effect.gen(function* () {
        const ctx = yield* Layer.build(storageLayer)
        const storage = Context.get(ctx, ActorPersistenceStorage)
        const wave1Layer = ActorHost.fromResolvedWithPersistence(resolved, {
          profileId,
          writeInterval: Duration.millis(1),
        }).pipe(
          Layer.provideMerge(ActorEngine.Live),
          Layer.provideMerge(Layer.succeed(ActorPersistenceStorage, storage)),
        )
        // Wave 1 — drive state, force a snapshot write, close scope.
        yield* Effect.gen(function* () {
          const wave1Scope = yield* Scope.make()
          const wave1Ctx = yield* Layer.buildWithScope(wave1Layer, wave1Scope)
          const engine = Context.get(wave1Ctx, ActorEngine)
          const reg = Context.get(wave1Ctx, Receptionist)
          const refs = yield* reg.find(PingService)
          const ref = refs[0] as ActorRef<PingMsg>
          yield* engine.tell(ref, PingMsg.Bump.make({}))
          yield* engine.tell(ref, PingMsg.Bump.make({}))
          yield* engine.tell(ref, PingMsg.Bump.make({}))
          // Drain via ask — guarantees the three Bump messages have been
          // processed and the post-state is in the per-actor stateRef
          // before we close the scope.
          const drained = yield* engine.ask(ref, PingMsg.Get.make({}))
          expect(drained).toBe(3)
          // Poll the storage row until the periodic writer has emitted
          // it. With writeInterval=1ms the first tick fires almost
          // immediately, but we still wait deterministically rather
          // than guessing a sleep duration.
          // The periodic writer ticks every 1ms — wait until the row
          // reflects the *final* drained state (`hits: 3`), not just
          // whatever the writer captured on its first tick.
          const namespacedKey = namespacePersistenceKey("@test/persist", "counter")
          const waitForRow = Effect.gen(function* () {
            while (true) {
              const row = yield* storage.loadActorState({
                profileId,
                persistenceKey: namespacedKey,
              })
              if (row !== undefined) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only decode of stored JSON; shape is PingState
                const parsed = JSON.parse(row.stateJson) as {
                  hits: number
                }
                if (parsed.hits === 3) return row
              }
              yield* Effect.sleep(Duration.millis(5))
            }
          })
          yield* waitForRow.pipe(Effect.timeout("2 seconds"))
          yield* Scope.close(wave1Scope, Exit.void)
        })
        // Wave 2 — fresh scope, same storage. restoredState is read from
        // the row written by wave 1's periodic writer.
        const observed = yield* Effect.gen(function* () {
          const wave2Scope = yield* Scope.make()
          const wave2Ctx = yield* Layer.buildWithScope(wave1Layer, wave2Scope)
          const engine = Context.get(wave2Ctx, ActorEngine)
          const reg = Context.get(wave2Ctx, Receptionist)
          const refs = yield* reg.find(PingService)
          const ref = refs[0] as ActorRef<PingMsg>
          const hits = yield* engine.ask(ref, PingMsg.Get.make({}))
          yield* Scope.close(wave2Scope, Exit.void)
          return hits
        })
        expect(observed).toBe(3)
      }).pipe(Effect.scoped)
    }),
  )
  it.live("malformed restored state fails closed without overwriting the durable row", () =>
    Effect.gen(function* () {
      const profileId = "test-malformed-restore"
      const persistedBehavior = makePingBehavior("counter")
      const resolved = makeResolved([makeLoaded("@test/malformed", [persistedBehavior])])
      const storageLayer = Storage.MemoryWithSql()
      const namespacedKey = namespacePersistenceKey("@test/malformed", "counter")
      yield* Effect.gen(function* () {
        const ctx = yield* Layer.build(storageLayer)
        const storage = Context.get(ctx, ActorPersistenceStorage)
        yield* storage.saveActorState({
          profileId,
          persistenceKey: namespacedKey,
          stateJson: "{bad-json",
        })
        const hostLayer = ActorHost.fromResolvedWithPersistence(resolved, {
          profileId,
          writeInterval: Duration.millis(1),
        }).pipe(
          Layer.provideMerge(ActorEngine.Live),
          Layer.provideMerge(Layer.succeed(ActorPersistenceStorage, storage)),
        )
        const hostScope = yield* Scope.make()
        const hostCtx = yield* Layer.buildWithScope(hostLayer, hostScope)
        const reg = Context.get(hostCtx, Receptionist)
        const refs = yield* reg.find(PingService)
        expect(refs.length).toBe(0)
        const failures = yield* Context.get(hostCtx, ActorHostFailures).snapshot
        expect(failures.length).toBe(1)
        expect(failures[0]?.extensionId).toBe("@test/malformed")
        expect(failures[0]?.error).toContain("restore parse failed")
        yield* Scope.close(hostScope, Exit.void)
        const row = yield* storage.loadActorState({ profileId, persistenceKey: namespacedKey })
        expect(row?.stateJson).toBe("{bad-json")
      }).pipe(Effect.scoped)
    }),
  )
  it.live("snapshot write failures are recorded in ActorHostFailures", () =>
    Effect.gen(function* () {
      const profileId = "test-write-failure"
      const persistedBehavior = makePingBehavior("counter")
      const resolved = makeResolved([makeLoaded("@test/write-failure", [persistedBehavior])])
      const failingStorage: ActorPersistenceStorageService = {
        saveActorState: () =>
          Effect.fail(new StorageError({ message: "intentional actor save failure" })),
        loadActorState: () => Effect.succeed(undefined),
        listActorStatesForProfile: () => Effect.succeed([]),
        deleteActorStatesForProfile: () => Effect.void,
      }
      const hostLayer = ActorHost.fromResolvedWithPersistence(resolved, {
        profileId,
        writeInterval: Duration.millis(1),
      }).pipe(
        Layer.provideMerge(ActorEngine.Live),
        Layer.provideMerge(ActorPersistenceStorage.fromStorage(failingStorage)),
      )
      const failures = yield* Effect.scoped(
        Effect.gen(function* () {
          const hostCtx = yield* Layer.build(hostLayer)
          yield* Effect.sleep(Duration.millis(10))
          return yield* Context.get(hostCtx, ActorHostFailures).snapshot
        }),
      )
      expect(failures.some((f) => f.extensionId === "@test/write-failure")).toBe(true)
      expect(failures.some((f) => f.error.includes("persist write failed"))).toBe(true)
    }),
  )
  it.live("flushes the trailing-window state on host scope close", () =>
    Effect.gen(function* () {
      // The periodic writer's `Schedule.spaced` fires the first tick
      // almost immediately, then waits the interval. With a long
      // interval, the gap between the first tick and scope close is
      // wide — any state mutation in that window is the trailing data
      // that only the on-close finalizer can capture. We drive Bumps
      // *after* letting the writer fire its first tick, so the row's
      // pre-close `hits` is < the post-close `hits`. If the finalizer
      // is removed, the post-close row stays at the writer's tick
      // value, not the drained value.
      const profileId = "test-finalizer"
      const persistedBehavior = makePingBehavior("counter")
      const resolved = makeResolved([makeLoaded("@test/finalizer", [persistedBehavior])])
      const storageLayer = Storage.MemoryWithSql()
      const namespacedKey = namespacePersistenceKey("@test/finalizer", "counter")
      yield* Effect.gen(function* () {
        const ctx = yield* Layer.build(storageLayer)
        const storage = Context.get(ctx, ActorPersistenceStorage)
        const hostLayer = ActorHost.fromResolvedWithPersistence(resolved, {
          profileId,
          // Large enough that the writer fires only its first tick
          // during this test run; the trailing window is everything
          // afterward.
          writeInterval: Duration.minutes(5),
        }).pipe(
          Layer.provideMerge(ActorEngine.Live),
          Layer.provideMerge(Layer.succeed(ActorPersistenceStorage, storage)),
        )
        const wave1Scope = yield* Scope.make()
        const wave1Ctx = yield* Layer.buildWithScope(hostLayer, wave1Scope)
        const engine = Context.get(wave1Ctx, ActorEngine)
        const reg = Context.get(wave1Ctx, Receptionist)
        const refs = yield* reg.find(PingService)
        const ref = refs[0] as ActorRef<PingMsg>
        // Wait for the writer's first tick to land its row, so we
        // have a stable "pre-close" snapshot to compare against.
        const waitForRow = Effect.gen(function* () {
          while (true) {
            const row = yield* storage.loadActorState({
              profileId,
              persistenceKey: namespacedKey,
            })
            if (row !== undefined) return row
            yield* Effect.sleep(Duration.millis(5))
          }
        })
        const initialRow = yield* waitForRow.pipe(Effect.timeout("2 seconds"))
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only decode
        const initialParsed = JSON.parse(initialRow.stateJson) as {
          hits: number
        }
        expect(initialParsed.hits).toBe(0)
        // Trailing-window mutations: writer can't tick again before
        // scope close (5min interval), so only the finalizer can
        // capture these.
        yield* engine.tell(ref, PingMsg.Bump.make({}))
        yield* engine.tell(ref, PingMsg.Bump.make({}))
        yield* engine.tell(ref, PingMsg.Bump.make({}))
        const drained = yield* engine.ask(ref, PingMsg.Get.make({}))
        expect(drained).toBe(3)
        yield* Scope.close(wave1Scope, Exit.void)
        const afterClose = yield* storage.loadActorState({
          profileId,
          persistenceKey: namespacedKey,
        })
        expect(afterClose).toBeDefined()
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only decode
        const parsed = JSON.parse(afterClose!.stateJson) as {
          hits: number
        }
        expect(parsed.hits).toBe(3)
      }).pipe(Effect.scoped)
    }),
  )
  it.live("extension with empty actors bucket is a no-op", () =>
    Effect.gen(function* () {
      const resolved = makeResolved([makeLoaded("@test/empty", [])])
      const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
      const live = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(PingService)
        }).pipe(Effect.provide(layer)),
      )
      expect(live).toEqual([])
    }),
  )
  it.live("multiple actors per extension all spawn", () =>
    Effect.gen(function* () {
      const counter = makePingBehavior()
      const resolved = makeResolved([
        makeLoaded("@test/a", [counter, counter]),
        makeLoaded("@test/b", [counter]),
      ])
      const layer = ActorHost.fromResolved(resolved).pipe(Layer.provideMerge(ActorEngine.Live))
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          const refs = yield* reg.find(PingService)
          return refs.length
        }).pipe(Effect.provide(layer)),
      )
      expect(observed).toBe(3)
    }),
  )
})
// Defensive sanity: prove the host *uses* the engine, not a parallel
// shadow registry. If a future refactor swapped the engine for a stub,
// this test would fail because ActorEngine spawn is the only path
// that registers refs with Receptionist.
describe("ActorHost — engine integration", () => {
  it.live("a Behavior with no serviceKey is spawned but not registered", () =>
    Effect.gen(function* () {
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
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(PingService)
        }).pipe(Effect.provide(layer)),
      )
      expect(found).toEqual([])
    }),
  )
  it.live("Ref-based observability — spawned actor receives messages", () =>
    Effect.gen(function* () {
      // Use a stateful Ref to confirm the spawned actor's receive loop is
      // actually running, not just registered.
      const counter = yield* Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* Ref.make(0)
          const Tick = TaggedEnumClass("Tick", {
            Bump: {},
            Read: TaggedEnumClass.askVariant<number>()({}),
          })
          type Tick = Schema.Schema.Type<typeof Tick>
          const TickKey = ServiceKey<Tick>("tick-key")
          const behavior: Behavior<
            Tick,
            {
              n: number
            },
            never
          > = {
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
              }) as Effect.Effect<
                {
                  n: number
                },
                never,
                never
              >,
          }
          const resolved = makeResolved([makeLoaded("@test/tick", [behavior as never])])
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
              const seen = yield* engine.ask(target, Tick.Read.make({}))
              return seen
            }).pipe(Effect.provide(layer)),
          )
        }),
      )
      expect(counter).toBe(3)
    }),
  )
})
