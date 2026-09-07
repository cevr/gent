import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import {
  AgentEvent,
  EventId,
  EventStore,
  type EventEnvelope,
} from "@gent/core-internal/domain/event"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { Branch, dateFromMillis, Session } from "@gent/core-internal/domain/message"
import { SESSION_NOTIFICATION_CAPACITY } from "@gent/core-internal/domain/session-pubsub-registry"
import { EventStoreLive } from "@gent/core-internal/runtime/event-store-live"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"

const sessionId = SessionId.make("session-delivery")
const branchId = BranchId.make("branch-delivery")
const otherBranch = BranchId.make("branch-delivery-other")

const chunk = (index: number, branch: BranchId = branchId) =>
  AgentEvent.cases.StreamChunk.make({ sessionId, branchId: branch, chunk: `chunk-${index}` })

const ids = (envelopes: ReadonlyArray<EventEnvelope>) => envelopes.map((env) => Number(env.id))

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

const durableLayer = EventStoreLive.pipe(
  Layer.provideMerge(SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))),
)

/** The durable store validates the session and branch rows before it appends. */
const ensureSession = Effect.gen(function* () {
  const sessions = yield* Effect.serviceOption(SessionStorage)
  const branches = yield* Effect.serviceOption(BranchStorage)
  if (sessions._tag === "None" || branches._tag === "None") return
  const now = dateFromMillis(0)
  yield* sessions.value.createSession(
    new Session({ id: sessionId, createdAt: now, updatedAt: now }),
  )
  for (const id of [branchId, otherBranch]) {
    yield* branches.value.createBranch(new Branch({ id, sessionId, createdAt: now }))
  }
})

const stores = [
  { name: "memory", layer: EventStore.Memory },
  { name: "durable", layer: durableLayer },
]

describe("event stream delivery", () => {
  for (const store of stores) {
    describe(store.name, () => {
      it.scopedLive("a stalled subscriber never blocks publishers and catches up in order", () =>
        Effect.gen(function* () {
          yield* ensureSession
          const eventStore = yield* EventStore
          const total = SESSION_NOTIFICATION_CAPACITY * 3
          const gate = yield* Deferred.make<void>()
          // The subscriber opens its stream, then stalls before taking anything.
          const stalled = yield* eventStore.subscribe({ sessionId }).pipe(
            Stream.tap(() => Deferred.await(gate)),
            Stream.take(total),
            Stream.runCollect,
            Effect.forkChild,
          )
          yield* Effect.yieldNow
          // Publishing must not wait for the stalled subscriber.
          yield* Effect.forEach(range(1, total), (index) => eventStore.publish(chunk(index)), {
            discard: true,
          }).pipe(Effect.timeout("5 seconds"))

          yield* Deferred.succeed(gate, void 0)
          const received = yield* Fiber.join(stalled).pipe(Effect.timeout("5 seconds"))
          expect(ids(received)).toEqual(range(1, total))
        }).pipe(Effect.provide(store.layer), Effect.timeout("15 seconds")),
      )

      it.scopedLive("appends during backlog replay are neither lost nor repeated", () =>
        Effect.gen(function* () {
          yield* ensureSession
          const eventStore = yield* EventStore
          yield* Effect.forEach(range(1, 50), (index) => eventStore.publish(chunk(index)), {
            discard: true,
          })
          const collector = yield* eventStore
            .subscribe({ sessionId, branchId })
            .pipe(Stream.take(150), Stream.runCollect, Effect.forkChild)
          // Race the backlog drain with live appends.
          yield* Effect.forEach(range(51, 150), (index) => eventStore.publish(chunk(index)), {
            discard: true,
          })
          const received = yield* Fiber.join(collector).pipe(Effect.timeout("5 seconds"))
          expect(ids(received)).toEqual(range(1, 150))
        }).pipe(Effect.provide(store.layer), Effect.timeout("15 seconds")),
      )

      it.scopedLive("a branch subscriber skips other branches during replay and live", () =>
        Effect.gen(function* () {
          yield* ensureSession
          const eventStore = yield* EventStore
          yield* eventStore.publish(chunk(1))
          yield* eventStore.publish(chunk(2, otherBranch))
          const collector = yield* eventStore
            .subscribe({ sessionId, branchId })
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
          yield* eventStore.publish(chunk(3, otherBranch))
          yield* eventStore.publish(chunk(4))
          const received = yield* Fiber.join(collector).pipe(Effect.timeout("5 seconds"))
          expect(ids(received)).toEqual([1, 4])
        }).pipe(Effect.provide(store.layer), Effect.timeout("15 seconds")),
      )

      it.scopedLive("a synchronized subscriber sees one marker between replay and live", () =>
        Effect.gen(function* () {
          yield* ensureSession
          const eventStore = yield* EventStore
          yield* eventStore.publish(chunk(1))
          yield* eventStore.publish(chunk(2))
          // The marker carries the replay cursor even when the branch filter hid the last event.
          yield* eventStore.publish(chunk(3, otherBranch))
          // The live append happens only after the marker, so replay and live are distinct.
          const received = yield* eventStore
            .subscribe({ sessionId, branchId, after: EventId.make(1), synchronize: true })
            .pipe(
              Stream.tap((env) =>
                Effect.gen(function* () {
                  if (env.event._tag === "StreamSynchronized") yield* eventStore.publish(chunk(4))
                }),
              ),
              Stream.take(3),
              Stream.runCollect,
              Effect.timeout("5 seconds"),
            )
          expect(received.map((env) => [Number(env.id), env.event._tag])).toEqual([
            [2, "StreamChunk"],
            [3, "StreamSynchronized"],
            [4, "StreamChunk"],
          ])
          expect(received[1]?.event).toMatchObject({ sessionId, branchId, lastEventId: 3 })
          // Plain subscribers keep the bare event sequence.
          const plain = yield* eventStore
            .subscribe({ sessionId, branchId })
            .pipe(Stream.take(3), Stream.runCollect)
          expect(ids(plain)).toEqual([1, 2, 4])
        }).pipe(Effect.provide(store.layer), Effect.timeout("15 seconds")),
      )

      it.scopedLive("the synchronization marker is never stored", () =>
        Effect.gen(function* () {
          yield* ensureSession
          const eventStore = yield* EventStore
          const error = yield* eventStore
            .publish(
              AgentEvent.cases.StreamSynchronized.make({
                sessionId,
                branchId,
                lastEventId: EventId.make(0),
              }),
            )
            .pipe(Effect.flip)
          expect(error._tag).toBe("EventStoreError")
          const events = yield* eventStore
            .subscribe({ sessionId, synchronize: true })
            .pipe(Stream.take(1), Stream.runCollect)
          expect(events.map((env) => [Number(env.id), env.event._tag])).toEqual([
            [0, "StreamSynchronized"],
          ])
        }).pipe(Effect.provide(store.layer), Effect.timeout("15 seconds")),
      )
    })
  }
})
