/**
 * W9-3 — Receptionist.
 *
 * SubscriptionRef-backed registry of `ActorRef<M>` keyed by
 * `ServiceKey<M>.name`. Tests target the public surface only:
 * register/unregister/find/subscribe.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { Receptionist } from "@gent/core/runtime/extensions/receptionist"
import { ServiceKey, type ActorRef } from "@gent/core/domain/actor"
import { ActorId } from "@gent/core/domain/ids"
interface PingMsg {
  readonly _tag: "Ping"
}
const makeRef = (id: string): ActorRef<PingMsg> => ({
  _tag: "ActorRef",
  id: Schema.decodeUnknownSync(ActorId)(id),
})
describe("Receptionist", () => {
  it.live("registration roundtrip — find returns the registered ref", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("ping")
      const ref = makeRef("019dcc00-0000-7000-8000-000000000001")
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          yield* reg.register(key, ref)
          return yield* reg.find(key)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(found).toEqual([ref])
    }),
  )
  it.live("find on missing key returns empty array", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("absent")
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(key)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(found).toEqual([])
    }),
  )
  it.live("findOne returns undefined when no refs are registered", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("absent-one")
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.findOne(key)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(found).toBeUndefined()
    }),
  )
  it.live("findOne returns the only registered ref", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("singleton")
      const ref = makeRef("019dcc00-0000-7000-8000-000000000020")
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          yield* reg.register(key, ref)
          return yield* reg.findOne(key)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(found).toEqual(ref)
    }),
  )
  it.live("findOne returns undefined after the lone ref is unregistered", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("transient")
      const ref = makeRef("019dcc00-0000-7000-8000-000000000021")
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          yield* reg.register(key, ref)
          yield* reg.unregister(key, ref)
          return yield* reg.findOne(key)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(found).toBeUndefined()
    }),
  )
  it.live("unregister removes the ref; remaining refs survive", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("svc")
      const a = makeRef("019dcc00-0000-7000-8000-000000000010")
      const b = makeRef("019dcc00-0000-7000-8000-000000000011")
      const remaining = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          yield* reg.register(key, a)
          yield* reg.register(key, b)
          yield* reg.unregister(key, a)
          return yield* reg.find(key)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(remaining).toEqual([b])
    }),
  )
  it.live("concurrent registers do not drop entries", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("burst")
      const N = 64
      const refs = Array.from({ length: N }, (_, i) =>
        makeRef(`019dcc00-0000-7000-8000-${String(i).padStart(12, "0")}`),
      )
      const found = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          yield* Effect.all(
            refs.map((r) => reg.register(key, r)),
            { concurrency: "unbounded" },
          )
          return yield* reg.find(key)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(found.length).toBe(N)
      const ids = new Set(found.map((r) => r.id))
      for (const r of refs) expect(ids.has(r.id)).toBe(true)
    }),
  )
  it.live("subscribe emits a fresh snapshot on register and unregister", () =>
    Effect.gen(function* () {
      const key = ServiceKey<PingMsg>("watch")
      const a = makeRef("019dcc00-0000-7000-8000-000000000020")
      const b = makeRef("019dcc00-0000-7000-8000-000000000021")
      const snapshots = yield* Effect.scoped(
        Effect.gen(function* () {
          const reg = yield* Receptionist
          // Take 4 snapshots: initial empty, +a, +b, then -a.
          const fiber = yield* Effect.forkChild(
            reg.subscribe(key).pipe(Stream.take(4), Stream.runCollect),
          )
          // Yield so the subscriber attaches and receives the initial snapshot.
          yield* Effect.yieldNow
          yield* reg.register(key, a)
          yield* Effect.yieldNow
          yield* reg.register(key, b)
          yield* Effect.yieldNow
          yield* reg.unregister(key, a)
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(Receptionist.Live)),
      )
      expect(snapshots.length).toBe(4)
      expect(snapshots[0]).toEqual([])
      expect(snapshots[1]!.map((r) => r.id)).toEqual([a.id])
      expect(new Set(snapshots[2]!.map((r) => r.id))).toEqual(new Set([a.id, b.id]))
      expect(snapshots[3]!.map((r) => r.id)).toEqual([b.id])
    }),
  )
})
