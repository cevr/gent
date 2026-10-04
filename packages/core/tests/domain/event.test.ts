import { Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import {
  AgentEvent,
  BranchCreated,
  BranchSwitched,
  ErrorOccurred,
  type EventEnvelope,
  EventId,
  EventStore,
  type EventStoreService,
  getEventBranchId,
  getEventSessionId,
  makeSerializedEventDelivery,
  SESSION_NOTIFICATION_CAPACITY,
  SessionNameUpdated,
  SessionSettingsUpdated,
  StreamChunk,
  TurnCompleted,
} from "../../src/domain/event"
import { BranchId, SessionId, ToolCallId } from "../../src/domain/ids"
import { describe, expect, it, test } from "effect-bun-test"
import { Branch, dateFromMillis, Session } from "../../src/domain/message"
import { EventStoreLive } from "../../src/runtime/session"
import { BranchStorage, SessionStorage } from "../../src/storage/storage"
import { testSqliteStorage } from "../../src/test-utils/harness"

const session = SessionId.make("session-1")
const branch = BranchId.make("branch-1")

test("turn receipts preserve model failure and leave historical outcomes unspecified", () => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(TurnCompleted))
  const encode = Schema.encodeSync(Schema.fromJsonString(TurnCompleted))
  const historical = TurnCompleted.make({ sessionId: session, branchId: branch, durationMs: 1 })
  expect(decode(encode(historical)).streamFailed).toBeUndefined()
  for (const streamFailed of [true, false]) {
    const receipt = TurnCompleted.make({ ...historical, streamFailed })
    expect(decode(encode(receipt)).streamFailed).toBe(streamFailed)
  }
})

test("an error row from before reset times decodes, and a reset time survives the store", () => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ErrorOccurred))
  const encode = Schema.encodeSync(Schema.fromJsonString(ErrorOccurred))
  const historical = decode(
    '{"_tag":"ErrorOccurred","sessionId":"session-1","branchId":"branch-1","error":"Rate limit"}',
  )
  expect(historical.retryAt).toBeUndefined()
  const limited = ErrorOccurred.make({ ...historical, retryAt: 1_800_000_000_000 })
  expect(decode(encode(limited)).retryAt).toBe(1_800_000_000_000)
})

describe("event session routing", () => {
  test("standard variants surface the session field", () => {
    const event = StreamChunk.make({
      sessionId: session,
      branchId: branch,
      chunk: "hi",
    })
    expect(getEventSessionId(event)).toBe(session)
  })
})

describe("event branch routing", () => {
  test("BranchSwitched returns undefined to match either-side delivery", () => {
    const switched = BranchSwitched.make({
      sessionId: session,
      fromBranchId: branch,
      toBranchId: BranchId.make("branch-2"),
    })
    expect(getEventBranchId(switched)).toBeUndefined()
  })

  test("SessionNameUpdated and SessionSettingsUpdated have no branch", () => {
    const named = SessionNameUpdated.make({ sessionId: session, name: "x" })
    const settings = SessionSettingsUpdated.make({ sessionId: session })
    expect(getEventBranchId(named)).toBeUndefined()
    expect(getEventBranchId(settings)).toBeUndefined()
  })

  test("standard variants surface the branch field", () => {
    const event = BranchCreated.make({
      sessionId: session,
      branchId: branch,
    })
    expect(getEventBranchId(event)).toBe(branch)
  })
})

// ── event delivery ─────────────────────────────────────────────────────────

const FIXED_NOW_MILLIS = dateFromMillis(1_767_225_600_000).getTime()

// One real event for the store tests: they read only its tag and its ids.
const toolCallStarted = (sessionId: string, branchId: string): AgentEvent =>
  AgentEvent.cases.ToolCallStarted.make({
    sessionId: SessionId.make(sessionId),
    branchId: BranchId.make(branchId),
    toolCallId: ToolCallId.make(`call-${sessionId}`),
    toolName: "probe",
  })

const makeEventStoreLayer = (
  input: Pick<EventStoreService, "append"> & {
    readonly broadcast: (envelope: EventEnvelope) => Effect.Effect<void>
  },
): Layer.Layer<EventStore> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const deliver = yield* makeSerializedEventDelivery(input.broadcast)
      const service: EventStoreService = {
        append: input.append,
        deliver,
        publish: Effect.fn("TestEventStore.publish")(function* (event) {
          const envelope = yield* input.append(event)
          yield* deliver(envelope)
        }),
        subscribe: () => Stream.die("subscribe not exercised in delivery tests"),
        removeSession: () => Effect.void,
      }
      return Layer.succeed(EventStore, service)
    }),
  )

// Delivery is observable through EventStore append/broadcast.
describe("EventStore publish and delivery", () => {
  it.live("normal publish appends and broadcasts the committed event", () =>
    Effect.gen(function* () {
      const persisted: string[] = []
      const broadcasted: string[] = []
      let nextId = 0
      const baseLayer = makeEventStoreLayer({
        append: (event: AgentEvent) =>
          Effect.sync(() => {
            persisted.push(event._tag)
            nextId += 1
            return { id: EventId.make(nextId), event, createdAt: FIXED_NOW_MILLIS }
          }),
        broadcast: (envelope: EventEnvelope) =>
          Effect.sync(() => {
            broadcasted.push(envelope.event._tag)
          }),
      })
      const layer = baseLayer
      yield* Effect.gen(function* () {
        const eventStore = yield* EventStore
        yield* eventStore.publish(toolCallStarted("session-1", "branch-1"))
      }).pipe(Effect.provide(layer))
      expect(persisted).toEqual(["ToolCallStarted"])
      expect(broadcasted).toEqual(["ToolCallStarted"])
    }),
  )
  it.live("publish waits for serialized delivery before returning", () =>
    Effect.gen(function* () {
      // Publish no longer relies on an explicit scheduler yield. Publish
      // enqueues committed envelopes through a delivery worker and waits for the
      // broadcast acknowledgment before returning.
      const broadcastStarted = yield* Deferred.make<void>()
      const releaseBroadcast = yield* Deferred.make<void>()
      const customEventStore = makeEventStoreLayer({
        append: (event) =>
          Effect.succeed({
            id: EventId.make(1),
            event,
            createdAt: FIXED_NOW_MILLIS,
          }),
        broadcast: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(broadcastStarted, void 0)
            yield* Deferred.await(releaseBroadcast)
          }),
      })
      const layer = customEventStore
      yield* Effect.gen(function* () {
        const eventStore = yield* EventStore
        const fiber = yield* Effect.forkScoped(
          eventStore.publish(toolCallStarted("session-1", "branch-1")),
        )
        yield* Deferred.await(broadcastStarted)
        const early = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("1 millis"))
        expect(early._tag).toBe("None")
        yield* Deferred.succeed(releaseBroadcast, void 0)
        yield* Fiber.join(fiber)
      }).pipe(Effect.scoped, Effect.provide(layer))
    }),
  )
  it.live("deliver serializes duplicate committed envelopes", () =>
    Effect.gen(function* () {
      const firstBroadcastStarted = yield* Deferred.make<void>()
      const releaseFirstBroadcast = yield* Deferred.make<void>()
      const broadcastCount = yield* Ref.make(0)
      const envelope = {
        id: EventId.make(1),
        event: toolCallStarted("session-1", "branch-1"),
        createdAt: FIXED_NOW_MILLIS,
      }
      const customEventStore = makeEventStoreLayer({
        append: (event) => Effect.succeed({ ...envelope, event }),
        broadcast: () =>
          Effect.gen(function* () {
            yield* Ref.update(broadcastCount, (count) => count + 1)
            yield* Deferred.succeed(firstBroadcastStarted, void 0)
            yield* Deferred.await(releaseFirstBroadcast)
          }),
      })
      const layer = customEventStore
      yield* Effect.gen(function* () {
        const eventStore = yield* EventStore
        const first = yield* Effect.forkScoped(eventStore.deliver(envelope))
        yield* Deferred.await(firstBroadcastStarted)
        const second = yield* Effect.forkScoped(eventStore.deliver(envelope))
        expect(yield* Ref.get(broadcastCount)).toBe(1)
        yield* Deferred.succeed(releaseFirstBroadcast, void 0)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(yield* Ref.get(broadcastCount)).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(layer))
    }),
  )
  it.live("broadcast defects fail the caller without killing the delivery worker", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const envelope = {
        id: EventId.make(1),
        event: toolCallStarted("session-1", "branch-1"),
        createdAt: FIXED_NOW_MILLIS,
      }
      const customEventStore = makeEventStoreLayer({
        append: (event) => Effect.succeed({ ...envelope, event }),
        broadcast: () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) => {
              if (count === 1) {
                return Effect.die("broadcast defect")
              }
              return Effect.void
            }),
          ),
      })
      const layer = customEventStore
      yield* Effect.gen(function* () {
        const eventStore = yield* EventStore
        const failed = yield* Effect.exit(eventStore.deliver(envelope))
        expect(failed._tag).toBe("Failure")
        yield* eventStore.deliver(envelope)
      }).pipe(Effect.provide(layer))
      expect(yield* Ref.get(attempts)).toBe(2)
    }),
  )
})
// ── event stream delivery ───────────────────────────────────────────────────

const sessionId = SessionId.make("session-delivery")
const branchId = BranchId.make("branch-delivery")
const otherBranch = BranchId.make("branch-delivery-other")

const chunk = (index: number, branch: BranchId = branchId) =>
  AgentEvent.cases.StreamChunk.make({ sessionId, branchId: branch, chunk: `chunk-${index}` })

const ids = (envelopes: ReadonlyArray<EventEnvelope>) => envelopes.map((env) => Number(env.id))

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index)

const durableLayer = EventStoreLive.pipe(Layer.provideMerge(testSqliteStorage(Layer.empty, {})))

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

// ── agent event wire shape ──────────────────────────────────────────────────

describe("agent event wire shape", () => {
  const sessionId = SessionId.make("session_tagged_enum_wire_shape")
  const branchId = BranchId.make("branch_tagged_enum_wire_shape")
  test("SessionStarted encodes to its tag and fields and decodes back", () => {
    const evt = AgentEvent.cases.SessionStarted.make({ sessionId, branchId })
    const encoded = Schema.encodeUnknownSync(AgentEvent)(evt)
    expect(encoded).toEqual({ _tag: "SessionStarted", sessionId, branchId })
    const decoded = Schema.decodeSync(AgentEvent)(encoded)
    expect(Schema.is(AgentEvent.cases.SessionStarted)(decoded)).toBe(true)
  })
})
