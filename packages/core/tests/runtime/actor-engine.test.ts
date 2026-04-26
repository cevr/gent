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
import { Cause, Deferred, Effect, Schema } from "effect"
import { ActorEngine } from "@gent/core/runtime/extensions/actor-engine"
import { ActorAskTimeout, type Behavior } from "@gent/core/domain/actor"
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
})
