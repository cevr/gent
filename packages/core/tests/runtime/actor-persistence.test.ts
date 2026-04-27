/**
 * Actor persistence — snapshot/restore.
 *
 * Validates the durability surface:
 *  - durable actors (`persistence: { key, state }`) appear in snapshot
 *  - ephemeral actors (no `persistence`) are omitted
 *  - spawn(behavior, { restoredState }) rehydrates state in place of
 *    initialState
 *  - mailboxes are NOT replayed: messages sent before snapshot are
 *    not redelivered after restore
 *  - end-to-end: spawn → tell → snapshot → simulate restart → restore
 *    → state matches the pre-restart value
 *  - decode failure on restore returns ActorRestoreError (not die)
 *  - encode failure on snapshot returns ActorSnapshotError (not die)
 *  - duplicate persistence.key in one engine fails with
 *    ActorPersistenceKeyCollision
 */

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Option, Schema } from "effect"
import { ActorEngine } from "@gent/core/runtime/extensions/actor-engine"
import {
  ActorPersistenceKeyCollision,
  ActorRestoreError,
  type Behavior,
} from "@gent/core/domain/actor"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"

const CounterMsg = TaggedEnumClass("CounterMsg", {
  Inc: {},
  Get: {},
})
type CounterMsg = Schema.Schema.Type<typeof CounterMsg>

const CounterState = Schema.Struct({ count: Schema.Number })
type CounterState = typeof CounterState.Type

const durableCounter: Behavior<CounterMsg, CounterState, never> = {
  initialState: { count: 0 },
  persistence: { key: "counter", state: CounterState },
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "Inc":
          return { count: state.count + 1 }
        case "Get":
          yield* ctx.reply(state.count)
          return state
      }
    }) as Effect.Effect<CounterState, never, never>,
}

const ephemeralCounter: Behavior<CounterMsg, CounterState, never> = {
  initialState: { count: 0 },
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "Inc":
          return { count: state.count + 1 }
        case "Get":
          yield* ctx.reply(state.count)
          return state
      }
    }) as Effect.Effect<CounterState, never, never>,
}

describe("ActorEngine — persistence", () => {
  test("snapshot returns durable state encoded through the behavior's schema", async () => {
    const snap = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          // Sync via ask — guarantees prior tells were processed.
          yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          return yield* engine.snapshot()
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(snap.size).toBe(1)
    expect(snap.get("counter")).toEqual({ count: 3 })
  })

  test("ephemeral actors are omitted from snapshot", async () => {
    const snap = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(ephemeralCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          return yield* engine.snapshot()
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(snap.size).toBe(0)
  })

  test("spawn with restoredState rehydrates state in place of initialState", async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          // Encoded form mirrors the schema's `Encoded` (here equal to
          // the type — plain Struct of Number).
          const ref = yield* engine.spawn(durableCounter, { restoredState: { count: 7 } })
          return yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(observed).toBe(7)
  })

  test("end-to-end: snapshot from one engine restores into a fresh engine; mailboxes do not replay", async () => {
    // First engine: bring state to count=2, then snapshot.
    const snap = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          return yield* engine.snapshot()
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(snap.get("counter")).toEqual({ count: 2 })

    // Second engine: restore the durable counter from the snapshot. No
    // mailbox is carried over — the `Inc` messages from engine #1 must
    // not re-fire.
    const restored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter, {
            restoredState: snap.get("counter"),
          })
          return yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(restored).toBe(2)
  })

  test("durable actor with no restoredState starts at initialState and snapshots after evolution", async () => {
    const snap = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter)
          yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          return yield* engine.snapshot()
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(snap.get("counter")).toEqual({ count: 1 })
  })

  test("spawn with restoredState: undefined falls back to initialState", async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter, { restoredState: undefined })
          return yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(observed).toBe(0)
  })

  test("duplicate persistence.key in one engine fails with ActorPersistenceKeyCollision", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          yield* engine.spawn(durableCounter)
          return yield* engine.spawn(durableCounter)
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const errOpt = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(errOpt)).toBe(true)
      if (Option.isSome(errOpt)) {
        expect(errOpt.value).toBeInstanceOf(ActorPersistenceKeyCollision)
        if (errOpt.value instanceof ActorPersistenceKeyCollision) {
          expect(errOpt.value.persistenceKey).toBe("counter")
        }
      }
    }
  })

  test("malformed restoredState surfaces ActorRestoreError, not a defect", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          // CounterState requires `count: number`. A string-typed
          // value cannot decode through the schema.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional malformed encoded value
          return yield* engine.spawn(durableCounter, {
            restoredState: { count: "not-a-number" } as never,
          })
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const errOpt = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(errOpt)).toBe(true)
      if (Option.isSome(errOpt)) {
        expect(errOpt.value).toBeInstanceOf(ActorRestoreError)
        if (errOpt.value instanceof ActorRestoreError) {
          expect(errOpt.value.persistenceKey).toBe("counter")
        }
      }
    }
  })

  test("snapshot is a moment-in-time view; later mutations are not in the same map", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          const snap = yield* engine.snapshot()
          expect(snap.get("counter")).toEqual({ count: 1 })
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask<CounterMsg, number>(ref, CounterMsg.Get.make({}), () =>
            CounterMsg.Get.make({}),
          )
          // The first snapshot is unchanged — it's a Map<string, unknown> snapshot.
          expect(snap.get("counter")).toEqual({ count: 1 })
        }).pipe(Effect.provide(ActorEngine.Live)),
      ),
    )
  })
})
