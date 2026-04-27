/**
 * W9-2 — ActorEngine.
 *
 * Three-tier coverage:
 *  - pure reducer: Behavior.receive evolves state correctly
 *  - actor runtime: spawn + tell + state evolution observable via ask
 *  - supervision: failure inside receive does NOT terminate the actor;
 *    next message is processed against the prior state.
 *
 * `find` / `subscribe` return empty / never until W9-3 (Receptionist).
 */

import { describe, expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { ActorEngine } from "@gent/core/runtime/extensions/actor-engine"
import { Receptionist } from "@gent/core/runtime/extensions/receptionist"
import { ActorAskTimeout, ServiceKey, type Behavior } from "@gent/core/domain/actor"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

const CounterMsg = TaggedEnumClass("CounterMsg", {
  Inc: {},
  Get: {},
  Boom: {},
})
type CounterMsg = Schema.Schema.Type<typeof CounterMsg>

interface CounterState {
  readonly count: number
}

const counterBehavior: Behavior<CounterMsg, CounterState, never> = {
  initialState: { count: 0 },
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "Inc":
          return { count: state.count + 1 }
        case "Get":
          yield* ctx.reply(state.count)
          return state
        case "Boom":
          return yield* Effect.fail("boom" as const)
      }
    }) as Effect.Effect<CounterState, never, never>,
}

describe("ActorEngine — pure reducer", () => {
  test("Behavior.receive folds Inc into +1", async () => {
    const ctx = {
      self: { _tag: "ActorRef", id: "a" } as never,
      tell: () => Effect.void,
      ask: () => Effect.die("unused"),
      reply: () => Effect.void,
      find: () => Effect.succeed([]),
      subscribe: () => Effect.die("unused"),
    } as never
    const next = await Effect.runPromise(
      counterBehavior.receive(CounterMsg.Inc.make({}), { count: 5 }, ctx) as Effect.Effect<
        CounterState,
        unknown,
        never
      >,
    )
    expect(next.count).toBe(6)
  })
})

describe("ActorEngine — runtime", () => {
  test("spawn + tell evolves state, observable via ask", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(counterBehavior)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          const count = yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          expect(count).toBe(3)
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })

  test("ask returns ActorAskTimeout when actor is unknown", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const phantomRef = { _tag: "ActorRef", id: "phantom-actor-id" } as never
          return yield* engine.ask<CounterMsg, number>(
            phantomRef,
            CounterMsg.Get.make({}),
            () => CounterMsg.Get.make({}),
            { askMs: 50 },
          )
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const found = Cause.findError(exit.cause, (e: unknown) => e instanceof ActorAskTimeout)
      expect(found).toBeDefined()
    }
  })

  test("ask times out when no reply arrives", async () => {
    const SilentMsg = TaggedEnumClass("SilentMsg", { NoReply: {} })
    type SilentMsg = Schema.Schema.Type<typeof SilentMsg>
    const silent: Behavior<SilentMsg, null, never> = {
      initialState: null,
      receive: () => Effect.succeed(null),
    }
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(silent)
          return yield* engine.ask<SilentMsg, number>(
            ref,
            SilentMsg.NoReply.make({}),
            () => SilentMsg.NoReply.make({}),
            { askMs: 50 },
          )
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const found = Cause.findError(exit.cause, (e: unknown) => e instanceof ActorAskTimeout)
      expect(found).toBeDefined()
    }
  })

  test("supervision: receive failure does not terminate the actor", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(counterBehavior)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Boom.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          const count = yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          expect(count).toBe(2)
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })

  test("tell to an unknown ref is a no-op (does not hang or fail)", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const phantomRef = { _tag: "ActorRef", id: "phantom-actor-id" } as never
          yield* engine.tell(phantomRef, CounterMsg.Inc.make({}))
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })

  test("layer scope teardown interrupts spawned actor fibers (B1 regression)", async () => {
    // Regression for W9-2 review B1: runtimeScope was leaked, so spawned
    // actors kept running after the layer scope closed. We assert that
    // closing the outer scope around ActorEngine.Live observably stops
    // the actor by blocking it in `receive` on an addFinalizer that
    // sets a Ref when the fiber is interrupted.
    const HoldMsg = TaggedEnumClass("HoldMsg", {
      Hold: {},
    })
    type HoldMsg = Schema.Schema.Type<typeof HoldMsg>

    await Effect.runPromise(
      Effect.gen(function* () {
        const reachedReceive = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()

        const holdBehavior: Behavior<HoldMsg, null, never> = {
          initialState: null,
          receive: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reachedReceive, undefined)
              yield* Effect.never
              return null
            }).pipe(
              Effect.onInterrupt(() => Effect.asVoid(Deferred.succeed(interrupted, undefined))),
            ) as Effect.Effect<null, never, never>,
        }

        const outerScope = yield* Scope.make()
        const engineCtx = yield* Layer.buildWithScope(ActorEngine.Live, outerScope)
        const engine = Context.get(engineCtx, ActorEngine)

        const ref = yield* engine.spawn(holdBehavior)
        yield* engine.tell(ref, HoldMsg.Hold.make({}))
        yield* Deferred.await(reachedReceive)

        // Close the outer scope — runtimeScope finalizer should run and
        // interrupt the parked receive fiber.
        yield* Scope.close(outerScope, Exit.void)
        // Wait for the interrupt finalizer with a short timeout to keep
        // the test deterministic if the scope teardown ever regresses.
        const result = yield* Deferred.await(interrupted).pipe(Effect.timeoutOption("1 second"))
        expect(result._tag).toBe("Some")
      }),
    )
  })

  test("defects in receive escalate and terminate the actor (B2 regression)", async () => {
    // Regression for W9-2 review B2: defects (Cause.Die) were silently
    // swallowed and the loop continued. They should escalate, killing
    // the actor's fiber, so a follow-up `ask` observes ActorAskTimeout
    // (no mailbox).
    const PoisonMsg = TaggedEnumClass("PoisonMsg", {
      Die: {},
      Ping: {},
    })
    type PoisonMsg = Schema.Schema.Type<typeof PoisonMsg>

    const poisonBehavior: Behavior<PoisonMsg, null, never> = {
      initialState: null,
      receive: (msg, _state, ctx) =>
        Effect.gen(function* () {
          if (msg._tag === "Die") {
            return yield* Effect.die("poisoned" as const)
          }
          yield* ctx.reply(1)
          return null
        }) as Effect.Effect<null, never, never>,
    }

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(poisonBehavior)
          yield* engine.tell(ref, PoisonMsg.Die.make({}))
          // Give the defect a moment to propagate through the fiber.
          yield* Effect.yieldNow
          // The actor's fiber is dead; mailbox entry is still in the
          // map but the receive fiber is no longer pulling from the
          // queue. ask must observe a timeout.
          return yield* engine.ask<PoisonMsg, number>(
            ref,
            PoisonMsg.Ping.make({}),
            () => PoisonMsg.Ping.make({}),
            { askMs: 50 },
          )
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const found = Cause.findError(exit.cause, (e: unknown) => e instanceof ActorAskTimeout)
      expect(found).toBeDefined()
    }
  })

  test("receptionist unregisters actor after fiber death (W10-0b regression)", async () => {
    // Regression for W10-0b: when an actor with a serviceKey dies
    // (defect or interrupt), its mailbox cleanup must call
    // receptionist.unregister so dead refs don't leak into discovery
    // results. Previously verified only by spawn-time wiring; this
    // test proves the cleanup path observably removes the ref.
    const PoisonMsg = TaggedEnumClass("PoisonMsg", {
      Die: {},
    })
    type PoisonMsg = Schema.Schema.Type<typeof PoisonMsg>
    const PoisonKey = ServiceKey<PoisonMsg>("poison-service")

    const poisonBehavior: Behavior<PoisonMsg, null, never> = {
      initialState: null,
      serviceKey: PoisonKey,
      receive: () =>
        Effect.gen(function* () {
          return yield* Effect.die("poisoned" as const)
        }) as Effect.Effect<null, never, never>,
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const receptionist = yield* Receptionist
          const ref = yield* engine.spawn(poisonBehavior)

          // Sanity: registered at spawn.
          const beforeDeath = yield* receptionist.find(PoisonKey)
          expect(beforeDeath).toEqual([ref])

          // Subscribe to the registry so we deterministically wait for
          // the unregister rather than polling with sleeps.
          const sawEmpty = yield* Deferred.make<void>()
          yield* receptionist.subscribe(PoisonKey).pipe(
            Stream.tap((refs) =>
              refs.length === 0 ? Deferred.succeed(sawEmpty, undefined) : Effect.void,
            ),
            Stream.runDrain,
            Effect.forkScoped,
          )

          yield* engine.tell(ref, PoisonMsg.Die.make({}))

          const observed = yield* Deferred.await(sawEmpty).pipe(Effect.timeoutOption("1 second"))
          expect(observed._tag).toBe("Some")

          // Final find: dead ref is gone from discovery.
          const afterDeath = yield* receptionist.find(PoisonKey)
          expect(afterDeath).toEqual([])
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })

  test("messages are delivered in submission order to a single actor", async () => {
    interface OrderState {
      readonly received: ReadonlyArray<number>
    }
    const OrderMsg = TaggedEnumClass("OrderMsg", {
      Push: { n: Schema.Number },
      Done: { latch: Schema.Any },
    })
    type OrderMsg = Schema.Schema.Type<typeof OrderMsg>
    const orderBehavior: Behavior<OrderMsg, OrderState, never> = {
      initialState: { received: [] },
      receive: (msg, state) =>
        Effect.gen(function* () {
          if (msg._tag === "Push") {
            return { received: [...state.received, msg.n] }
          }
          const latch = msg.latch as Deferred.Deferred<ReadonlyArray<number>>
          yield* Deferred.succeed(latch, state.received)
          return state
        }),
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(orderBehavior)
          yield* Effect.forEach(
            [1, 2, 3, 4, 5],
            (n) => engine.tell(ref, OrderMsg.Push.make({ n })),
            { discard: true },
          )
          const latch = yield* Deferred.make<ReadonlyArray<number>>()
          yield* engine.tell(ref, OrderMsg.Done.make({ latch }))
          const received = yield* Deferred.await(latch)
          expect(received).toEqual([1, 2, 3, 4, 5])
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })

  test("snapshot blocks until in-flight receive completes (W10-0d.2 regression)", async () => {
    // A receive that holds open until we explicitly release it must
    // make `snapshot()` wait. Without the per-actor permit, snapshot
    // would race: it would either see the pre-receive state (if the
    // actor hadn't taken the message yet) or the partially-mutated
    // state if `receive` were to perform multiple `Ref.set`s. The
    // assertion is structural — `snapshot()` must not resolve until we
    // release the gate.
    const Slow = TaggedEnumClass("Slow", { Hold: { latch: Schema.Any }, Tick: {} })
    type Slow = Schema.Schema.Type<typeof Slow>
    const SlowState = Schema.Struct({ done: Schema.Boolean })
    type SlowState = typeof SlowState.Type
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const reachedReceive = yield* Deferred.make<void>()
          const slow: Behavior<Slow, SlowState, never> = {
            initialState: { done: false },
            persistence: { key: "slow", state: SlowState },
            receive: (msg) =>
              Effect.gen(function* () {
                if (msg._tag === "Hold") {
                  yield* Deferred.succeed(reachedReceive, undefined)
                  yield* Deferred.await(msg.latch as Deferred.Deferred<void>)
                  return { done: true }
                }
                return { done: true }
              }) as Effect.Effect<SlowState, never, never>,
          }
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(slow)
          yield* engine.tell(ref, Slow.Hold.make({ latch: release }))
          yield* Deferred.await(reachedReceive)

          // Race snapshot against a guard that resolves only after we
          // release the receive. If the permit isn't honored, snapshot
          // wins (returns pre-state {done:false}) before the release
          // ever fires.
          const snapFiber = yield* Effect.forkChild(engine.snapshot())
          // Brief observation window: snapshot must NOT have resolved.
          yield* Effect.sleep("50 millis")
          const earlyExit = snapFiber.pollUnsafe()
          expect(earlyExit).toBeUndefined()

          yield* Deferred.succeed(release, undefined)
          const snap = yield* Fiber.await(snapFiber)
          expect(Exit.isSuccess(snap)).toBe(true)
          if (Exit.isSuccess(snap)) {
            const map = snap.value
            // Encoded post-state — `done: true` proves snapshot waited
            // for the in-flight receive to commit before reading.
            expect(map.get("slow")).toEqual({ done: true })
          }
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })
})

describe("ActorEngine — subscribeState", () => {
  test("emits initial state then post-receive state on every change", async () => {
    const collected: number[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(counterBehavior)

          // Run the consumer in the background; cancel after we have
          // observed the expected sequence.
          const fiber = yield* Effect.forkChild(
            Stream.runForEach(engine.subscribeState(ref), (s) =>
              Effect.sync(() => collected.push((s as CounterState).count)),
            ),
          )

          // Initial value reaches the consumer.
          yield* waitFor(() => collected.length >= 1)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* waitFor(() => collected.length >= 2)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* waitFor(() => collected.length >= 3)

          yield* Fiber.interrupt(fiber)
          expect(collected).toEqual([0, 1, 2])
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })

  test("dedupes consecutive equal states (filter-changed semantics)", async () => {
    // Behavior whose receive returns the SAME state structure on
    // every Touch — set into the channel happens unconditionally,
    // but `Stream.changes` collapses duplicates downstream.
    const Touch = TaggedEnumClass("Touch", { Touch: {} })
    type Touch = Schema.Schema.Type<typeof Touch>
    const idle: Behavior<Touch, { readonly v: number }, never> = {
      initialState: { v: 0 },
      receive: (_, state) => Effect.succeed(state),
    }
    const collected: number[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(idle)

          const fiber = yield* Effect.forkChild(
            Stream.runForEach(engine.subscribeState(ref), (s) =>
              Effect.sync(() => collected.push((s as { readonly v: number }).v)),
            ),
          )

          yield* waitFor(() => collected.length >= 1)
          yield* engine.tell(ref, Touch.Touch.make({}))
          yield* engine.tell(ref, Touch.Touch.make({}))
          yield* engine.tell(ref, Touch.Touch.make({}))
          // Give the loop time to drain — but Stream.changes should
          // suppress every set since v stays at 0.
          yield* Effect.sleep("50 millis")
          yield* Fiber.interrupt(fiber)
          expect(collected).toEqual([0])
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })

  test("subscribeState on unknown ref is empty (no hang, no fail)", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const phantom = { _tag: "ActorRef", id: "phantom-actor-id" } as never
          const items = yield* Stream.runCollect(engine.subscribeState(phantom))
          expect(items.length).toBe(0)
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })
})

/** Tiny polling helper — avoids `Effect.sleep` for state transitions per CLAUDE.md. */
const waitFor = (predicate: () => boolean, attempts = 50): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      if (predicate()) return
      yield* Effect.sleep("10 millis")
    }
  })
