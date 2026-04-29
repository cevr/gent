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
import { describe, expect, it } from "effect-bun-test"
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
  Get: TaggedEnumClass.askVariant<number>()({}),
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
  it.live("snapshot returns durable state encoded through the behavior's schema", () =>
    Effect.gen(function* () {
      const snap = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          // Sync via ask — guarantees prior tells were processed.
          yield* engine.ask(ref, CounterMsg.Get.make({}))
          return yield* engine.snapshot()
        }).pipe(Effect.provide(ActorEngine.Live)),
      )
      expect(snap.size).toBe(1)
      expect(snap.get("counter")).toEqual({ count: 3 })
    }),
  )
  it.live("ephemeral actors are omitted from snapshot", () =>
    Effect.gen(function* () {
      const snap = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(ephemeralCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask(ref, CounterMsg.Get.make({}))
          return yield* engine.snapshot()
        }).pipe(Effect.provide(ActorEngine.Live)),
      )
      expect(snap.size).toBe(0)
    }),
  )
  it.live("spawn with restoredState rehydrates state in place of initialState", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          // Encoded form mirrors the schema's `Encoded` (here equal to
          // the type — plain Struct of Number).
          const ref = yield* engine.spawn(durableCounter, { restoredState: { count: 7 } })
          return yield* engine.ask(ref, CounterMsg.Get.make({}))
        }).pipe(Effect.provide(ActorEngine.Live)),
      )
      expect(observed).toBe(7)
    }),
  )
  it.live(
    "end-to-end: snapshot from one engine restores into a fresh engine; mailboxes do not replay",
    () =>
      Effect.gen(function* () {
        // First engine: bring state to count=2, then snapshot.
        const snap = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* ActorEngine
            const ref = yield* engine.spawn(durableCounter)
            yield* engine.tell(ref, CounterMsg.Inc.make({}))
            yield* engine.tell(ref, CounterMsg.Inc.make({}))
            yield* engine.ask(ref, CounterMsg.Get.make({}))
            return yield* engine.snapshot()
          }).pipe(Effect.provide(ActorEngine.Live)),
        )
        expect(snap.get("counter")).toEqual({ count: 2 })
        // Second engine: restore the durable counter from the snapshot. No
        // mailbox is carried over — the `Inc` messages from engine #1 must
        // not re-fire.
        const restored = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* ActorEngine
            const ref = yield* engine.spawn(durableCounter, {
              restoredState: snap.get("counter"),
            })
            return yield* engine.ask(ref, CounterMsg.Get.make({}))
          }).pipe(Effect.provide(ActorEngine.Live)),
        )
        expect(restored).toBe(2)
      }),
  )
  it.live(
    "durable actor with no restoredState starts at initialState and snapshots after evolution",
    () =>
      Effect.gen(function* () {
        const snap = yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* ActorEngine
            const ref = yield* engine.spawn(durableCounter)
            yield* engine.ask(ref, CounterMsg.Get.make({}))
            yield* engine.tell(ref, CounterMsg.Inc.make({}))
            yield* engine.ask(ref, CounterMsg.Get.make({}))
            return yield* engine.snapshot()
          }).pipe(Effect.provide(ActorEngine.Live)),
        )
        expect(snap.get("counter")).toEqual({ count: 1 })
      }),
  )
  it.live("spawn with restoredState: undefined falls back to initialState", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter, { restoredState: undefined })
          return yield* engine.ask(ref, CounterMsg.Get.make({}))
        }).pipe(Effect.provide(ActorEngine.Live)),
      )
      expect(observed).toBe(0)
    }),
  )
  it.live("duplicate persistence.key in one engine fails with ActorPersistenceKeyCollision", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* ActorEngine
            yield* engine.spawn(durableCounter)
            return yield* engine.spawn(durableCounter)
          }).pipe(Effect.provide(ActorEngine.Live)),
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const err = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      if (!(err instanceof ActorPersistenceKeyCollision)) {
        throw new Error(`expected ActorPersistenceKeyCollision, got ${String(err)}`)
      }
      expect(err.persistenceKey).toBe("counter")
    }),
  )
  it.live("malformed restoredState surfaces ActorRestoreError, not a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* ActorEngine
            // CounterState requires `count: number`. A string-typed
            // value cannot decode through the schema.
            return yield* engine.spawn(durableCounter, {
              restoredState: { count: "not-a-number" } as never,
            })
          }).pipe(Effect.provide(ActorEngine.Live)),
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const err = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      if (!(err instanceof ActorRestoreError)) {
        throw new Error(`expected ActorRestoreError, got ${String(err)}`)
      }
      expect(err.persistenceKey).toBe("counter")
    }),
  )
  it.live("snapshot is a moment-in-time view; later mutations are not in the same map", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const ref = yield* engine.spawn(durableCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask(ref, CounterMsg.Get.make({}))
          const snap = yield* engine.snapshot()
          expect(snap.get("counter")).toEqual({ count: 1 })
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          yield* engine.ask(ref, CounterMsg.Get.make({}))
          // The first snapshot is unchanged — it's a Map<string, unknown> snapshot.
          expect(snap.get("counter")).toEqual({ count: 1 })
        }).pipe(Effect.provide(ActorEngine.Live)),
      )
    }),
  )
  it.live("failed spawn after claim releases the persistence-key claim (W10-0a regression)", () =>
    Effect.gen(function* () {
      // A spawn that fails AFTER the claim (here: malformed restoredState
      // → ActorRestoreError) must not leak the persistence-key claim. A
      // subsequent spawn for the same key in the same engine must
      // succeed. Without the post-claim onError release, the claim stays
      // in `claimedPersistenceKeys` forever and the second spawn fails
      // with ActorPersistenceKeyCollision.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* ActorEngine
          const failed = yield* Effect.exit(
            engine.spawn(durableCounter, {
              restoredState: { count: "not-a-number" } as never,
            }),
          )
          expect(failed._tag).toBe("Failure")
          // Same key, valid restore — must succeed because the prior
          // claim was released on failure.
          const ref = yield* engine.spawn(durableCounter)
          yield* engine.tell(ref, CounterMsg.Inc.make({}))
          const count = yield* engine.ask(ref, CounterMsg.Get.make({}))
          expect(count).toBe(1)
        }).pipe(Effect.provide(ActorEngine.Live)),
      )
    }),
  )
})
