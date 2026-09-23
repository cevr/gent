import { Deferred, Effect, Fiber, Layer, Option, Predicate, Ref, Schema, Stream } from "effect"
import {
  AgentEvent,
  BranchCreated,
  BranchSwitched,
  type EventEnvelope,
  EventId,
  EventPublisher,
  EventPublisherLive,
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
import { GentPlatform } from "../../src/runtime/gent-platform"
import { BranchStorage, SessionStorage, SqliteStorage } from "../../src/storage/storage"

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

// ── event publisher ─────────────────────────────────────────────────────────

const FIXED_NOW_MILLIS = dateFromMillis(1_767_225_600_000).getTime()

// Real AgentEvent variants used as stand-ins for synthetic test fixtures.
// Tests assert on `event._tag` strings; mapping each placeholder to a distinct
// real tag keeps the test logic stable while passing schema validation
// inside `getEventSessionId` / `getEventBranchId`.
const TAG_MAP = {
  OuterEvent: "ToolCallStarted",
  NestedEvent: "ToolCallSucceeded",
  BusNestedEvent: "ToolCallFailed",
  PrimaryEvent: "ToolCallStarted",
  SecondaryEvent: "ToolCallSucceeded",
  EventA: "ToolCallStarted",
  EventB: "ToolCallSucceeded",
  FallbackEvent: "ToolCallFailed",
} satisfies Record<string, "ToolCallStarted" | "ToolCallSucceeded" | "ToolCallFailed">
type SyntheticTag = keyof typeof TAG_MAP
type RealTag = (typeof TAG_MAP)[SyntheticTag]
const toBranchId = (branchId: Option.Option<string | BranchId>): BranchId => {
  if (Option.isNone(branchId)) return BranchId.make("default-branch")
  if (Predicate.isString(branchId.value)) return BranchId.make(branchId.value)
  return branchId.value
}
const toSessionId = (sessionId: string | SessionId): SessionId => {
  if (Predicate.isString(sessionId)) return SessionId.make(sessionId)
  return sessionId
}
const makeEvent = (
  tag: SyntheticTag,
  sessionId: string | SessionId,
  branchId?: string | BranchId,
): AgentEvent => {
  const realTag = TAG_MAP[tag]
  const sid = toSessionId(sessionId)
  const bid = toBranchId(Option.fromUndefinedOr(branchId))
  const base = {
    sessionId: sid,
    branchId: bid,
    toolCallId: ToolCallId.make(`${tag}-${sid}`),
    toolName: tag,
  }
  switch (realTag) {
    case "ToolCallStarted":
      return AgentEvent.cases.ToolCallStarted.make(base)
    case "ToolCallSucceeded":
      return AgentEvent.cases.ToolCallSucceeded.make(base)
    case "ToolCallFailed":
      return AgentEvent.cases.ToolCallFailed.make(base)
  }
}
// Tests reference these by their real tag names in expectations.
const TAG = TAG_MAP satisfies Record<SyntheticTag, RealTag>

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
        subscribe: () => Stream.die("subscribe not exercised in EventPublisher tests"),
        removeSession: () => Effect.void,
      }
      return Layer.succeed(EventStore, service)
    }),
  )

// EventPublisher delivery is observable through EventStore append/broadcast.
describe("EventPublisher", () => {
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
      const layer = Layer.provide(EventPublisherLive, baseLayer)
      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher
        yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      }).pipe(Effect.provide(layer))
      expect(persisted).toEqual([TAG.OuterEvent])
      expect(broadcasted).toEqual([TAG.OuterEvent])
    }),
  )
  it.live("publish waits for serialized delivery before returning", () =>
    Effect.gen(function* () {
      // The publisher no longer relies on an explicit scheduler yield. Publish
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
      const layer = Layer.provide(EventPublisherLive, customEventStore)
      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher
        const fiber = yield* Effect.forkScoped(
          publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1")),
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
        event: makeEvent("OuterEvent", "session-1", "branch-1"),
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
      const layer = Layer.provide(EventPublisherLive, customEventStore)
      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher
        const first = yield* Effect.forkScoped(publisher.deliver(envelope))
        yield* Deferred.await(firstBroadcastStarted)
        const second = yield* Effect.forkScoped(publisher.deliver(envelope))
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
        event: makeEvent("OuterEvent", "session-1", "branch-1"),
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
      const layer = Layer.provide(EventPublisherLive, customEventStore)
      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher
        const failed = yield* Effect.exit(publisher.deliver(envelope))
        expect(failed._tag).toBe("Failure")
        yield* publisher.deliver(envelope)
      }).pipe(Effect.provide(layer))
      expect(yield* Ref.get(attempts)).toBe(2)
    }),
  )
})
describe("EventPublisher server layer", () => {
  it.live("published events persist and broadcast through the shared store", () =>
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
      const layer = Layer.provide(EventPublisherLive, baseLayer)
      yield* Effect.gen(function* () {
        const publisher = yield* EventPublisher
        yield* publisher.publish(makeEvent("FallbackEvent", "session-secondary", "branch-1"))
      }).pipe(Effect.provide(layer))
      expect(persisted).toEqual([TAG.FallbackEvent])
      expect(broadcasted).toEqual([TAG.FallbackEvent])
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

const durableLayer = EventStoreLive.pipe(
  Layer.provideMerge(
    SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(GentPlatform.Test())),
  ),
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

// ── schema tagged union ─────────────────────────────────────────────────────

/**
 * `Schema.TaggedUnion` regression locks.
 *
 * Exercises upstream `Schema.TaggedUnion` / `Schema.TaggedStruct` +
 * `Schema.toTaggedUnion` directly — the invariants production call
 * sites rely on at the schema layer.
 *
 * Covered invariants:
 * - per-variant TaggedStruct identity (`Schema.is` narrows to a single case)
 * - constructor surface (`Enum.cases.Member.make({...})`)
 * - decode/encode round-trip at the union level
 * - `guards` validate the full payload (composed `Schema.is` per variant)
 * - `isAnyOf` and `match` dispatch on `_tag` ONLY (no payload validation) —
 *   regression-locked explicitly so future readers know not to feed untrusted
 *   values through them. Production callers only invoke these on values that
 *   already passed `Schema.decodeUnknownSync(...)` at the wire boundary, or
 *   that were constructed in-process via `cases.X.make(...)`.
 * - explicit wire-tag preservation via `Schema.TaggedStruct("wire-tag", ...)`
 *   unioned with `Schema.toTaggedUnion("_tag")`
 * - single-variant edge case
 * - per-enum identifier namespacing (distinct AST identity)
 * - Effect-friendly decode (no service requirements)
 *
 * @module
 */

describe("Schema.TaggedUnion — basic shape", () => {
  const Figures = Schema.TaggedUnion({
    Circle: { radius: Schema.Finite },
    Rectangle: { width: Schema.Finite, height: Schema.Finite },
  })
  test("cases bag exposes a constructible schema per member", () => {
    expect(Predicate.isFunction(Figures.cases.Circle)).toBe(true)
    expect(Predicate.isFunction(Figures.cases.Rectangle)).toBe(true)
    // oxlint-disable-next-line typescript/unbound-method -- This assertion inspects the constructor and does not invoke it.
    expect(Predicate.isFunction(Figures.cases.Circle.make)).toBe(true)
  })
  test("`cases.Variant.make(...)` constructs a value with the right `_tag`", () => {
    const c = Figures.cases.Circle.make({ radius: 5 })
    expect(c._tag).toBe("Circle")
    expect(c.radius).toBe(5)
  })
  test("schema guards work on directly-constructed variants", () => {
    const c = Figures.cases.Circle.make({ radius: 5 })
    const r = Figures.cases.Rectangle.make({ width: 3, height: 4 })
    expect(Schema.is(Figures.cases.Circle)(c)).toBe(true)
    expect(Schema.is(Figures.cases.Rectangle)(r)).toBe(true)
    expect(Schema.is(Figures.cases.Rectangle)(c)).toBe(false)
  })
})

describe("Schema.TaggedUnion — decode/encode round-trip", () => {
  const Figures = Schema.TaggedUnion({
    Circle: { radius: Schema.Finite },
    Rectangle: { width: Schema.Finite, height: Schema.Finite },
  })
  test("decode produces well-shaped values", () => {
    const decoded = Schema.decodeSync(Figures)({ _tag: "Circle", radius: 5 })
    expect(decoded._tag).toBe("Circle")
    if (decoded._tag === "Circle") {
      expect(decoded.radius).toBe(5)
    }
  })
  test("encode round-trips back to wire format", () => {
    const c = Figures.cases.Circle.make({ radius: 5 })
    const encoded = Schema.encodeUnknownSync(Figures)(c)
    expect(encoded).toEqual({ _tag: "Circle", radius: 5 })
  })
  test("decode rejects unknown `_tag`", () => {
    expect(() => Schema.decodeUnknownSync(Figures)({ _tag: "Unknown", radius: 5 })).toThrow()
  })
  test("decode rejects malformed payload", () => {
    expect(() =>
      Schema.decodeUnknownSync(Figures)({ _tag: "Circle", radius: "not a number" }),
    ).toThrow()
  })
})

describe("Schema.TaggedUnion — match / guards / isAnyOf", () => {
  const Figures = Schema.TaggedUnion({
    Circle: { radius: Schema.Finite },
    Rectangle: { width: Schema.Finite, height: Schema.Finite },
    Triangle: { base: Schema.Finite, height: Schema.Finite },
  })
  type Figures = Schema.Schema.Type<typeof Figures>
  test("`match` is exhaustive by member name", () => {
    const area = (s: Figures) =>
      Figures.match({
        Circle: (c) => Math.PI * c.radius ** 2,
        Rectangle: (r) => r.width * r.height,
        Triangle: (t) => (t.base * t.height) / 2,
      })(s)
    expect(area(Figures.cases.Circle.make({ radius: 1 }))).toBeCloseTo(Math.PI)
    expect(area(Figures.cases.Rectangle.make({ width: 3, height: 4 }))).toBe(12)
    expect(area(Figures.cases.Triangle.make({ base: 4, height: 6 }))).toBe(12)
  })
  test("`guards` narrow per member", () => {
    const c = Figures.cases.Circle.make({ radius: 5 })
    const r = Figures.cases.Rectangle.make({ width: 1, height: 2 })
    expect(Figures.guards.Circle(c)).toBe(true)
    expect(Figures.guards.Circle(r)).toBe(false)
    expect(Figures.guards.Rectangle(r)).toBe(true)
    expect(Figures.guards.Rectangle(c)).toBe(false)
  })
  test("`isAnyOf` checks subset membership by member name", () => {
    const c = Figures.cases.Circle.make({ radius: 5 })
    const r = Figures.cases.Rectangle.make({ width: 1, height: 2 })
    const t = Figures.cases.Triangle.make({ base: 1, height: 1 })
    const round = Figures.isAnyOf(["Circle"])
    const angular = Figures.isAnyOf(["Rectangle", "Triangle"])
    expect(round(c)).toBe(true)
    expect(round(r)).toBe(false)
    expect(angular(r)).toBe(true)
    expect(angular(t)).toBe(true)
    expect(angular(c)).toBe(false)
  })
})

describe("Schema.TaggedUnion — runtime-helper payload-validation semantics", () => {
  const Figures = Schema.TaggedUnion({
    Circle: { radius: Schema.Finite },
    Rectangle: { width: Schema.Finite, height: Schema.Finite },
  })
  type Figures = Schema.Schema.Type<typeof Figures>
  // A spoof value: right `_tag`, wrong payload shape. Constructed via
  // `as unknown as Figures` to bypass the type system — exactly the kind of
  // value a wire-boundary failure or a hostile decode would produce.
  // oxlint-disable-next-line effect/noAs, effect/noChainedTypeAssertions -- This test deliberately supplies a malformed payload to the tag-only dispatcher.
  const spoof = { _tag: "Circle", radius: "not a number" } as unknown as Figures
  test("`guards.X` validates the full payload — spoofed payload is rejected", () => {
    // `guards.X` is `Schema.is(case)` per variant in upstream, so the payload
    // shape is checked, not just the discriminator.
    expect(Figures.guards.Circle(spoof)).toBe(false)
  })
  test("`isAnyOf` is tag-only — spoofed payload is accepted", () => {
    // Regression-lock: `isAnyOf` matches against `_tag` only. Production
    // callers do not feed untrusted values through `isAnyOf`.
    expect(Figures.isAnyOf(["Circle"])(spoof)).toBe(true)
  })
  test("`match` is tag-only — dispatches on spoofed payload", () => {
    // Regression-lock: `match` dispatches via the `_tag` key into the
    // handler map without re-validating the payload. Production callers
    // (`AgentEvent.match` on events emitted in-process or decoded via
    // `Schema.decodeUnknownSync`) never see spoofed values.
    const out = Figures.match({
      Circle: (c) => String(c.radius),
      Rectangle: (r) => `rect:${r.width * r.height}`,
    })(spoof)
    expect(String(out)).toBe("not a number")
  })
})

describe("Schema.TaggedUnion — explicit wire tags via Schema.TaggedStruct + toTaggedUnion", () => {
  const TextDelta = Schema.TaggedStruct("text-delta", { text: Schema.String })
  const ToolCall = Schema.TaggedStruct("tool-call", {
    name: Schema.String,
    input: Schema.Unknown,
  })
  const ToolResult = Schema.TaggedStruct("tool-result", { result: Schema.Unknown })
  const Finished = Schema.TaggedStruct("finished", { reason: Schema.String })
  const WireEvent = Schema.Union([TextDelta, ToolCall, ToolResult, Finished]).pipe(
    Schema.toTaggedUnion("_tag"),
  )

  test("kebab-case wire tags construct through the per-variant struct", () => {
    const e = TextDelta.make({ text: "hello" })
    expect(e._tag).toBe("text-delta")
    expect(e.text).toBe("hello")
  })
  test("kebab-case wire tags decode through the union", () => {
    const decoded = Schema.decodeSync(WireEvent)({
      _tag: "text-delta",
      text: "hi",
    })
    expect(Schema.is(TextDelta)(decoded)).toBe(true)
  })
  test("match dispatches from wire-tag keys on the union", () => {
    const e = ToolCall.make({ name: "read", input: { path: "/x" } })
    const out = WireEvent.match(e, {
      "text-delta": (e) => `text:${e.text}`,
      "tool-call": (e) => `tool:${e.name}`,
      "tool-result": () => `result`,
      finished: () => `done`,
    })
    expect(out).toBe("tool:read")
  })
  test("`isAnyOf` accepts wire-tag keys", () => {
    const e = TextDelta.make({ text: "hello" })
    expect(WireEvent.isAnyOf(["text-delta"])(e)).toBe(true)
    expect(WireEvent.isAnyOf(["tool-call"])(e)).toBe(false)
  })
})

describe("Schema.TaggedUnion — single-variant edge case", () => {
  const Singleton = Schema.TaggedUnion({
    Only: { value: Schema.Finite },
  })
  test("construct/decode single variant", () => {
    const o = Singleton.cases.Only.make({ value: 42 })
    expect(o._tag).toBe("Only")
    const decoded = Schema.decodeSync(Singleton)({ _tag: "Only", value: 42 })
    expect(decoded._tag).toBe("Only")
  })
})

describe("Schema.TaggedUnion — namespacing via TaggedStruct identity", () => {
  const A = Schema.TaggedUnion({ Shared: { value: Schema.Finite } })
  const B = Schema.TaggedUnion({ Shared: { value: Schema.Finite } })
  test("same member name across enums has distinct case identity", () => {
    expect(A.cases.Shared).not.toBe(B.cases.Shared)
  })
})

describe("Schema.TaggedUnion — AgentEvent JSON wire shape", () => {
  const sessionId = SessionId.make("session_tagged_enum_wire_shape")
  const branchId = BranchId.make("branch_tagged_enum_wire_shape")
  test("AgentEvent.SessionStarted JSON wire shape unchanged", () => {
    const evt = AgentEvent.cases.SessionStarted.make({ sessionId, branchId })
    const encoded = Schema.encodeUnknownSync(AgentEvent)(evt)
    expect(encoded).toEqual({ _tag: "SessionStarted", sessionId, branchId })
    const decoded = Schema.decodeSync(AgentEvent)(encoded)
    expect(Schema.is(AgentEvent.cases.SessionStarted)(decoded)).toBe(true)
  })
})

describe("Schema.TaggedUnion — Effect-friendly decode", () => {
  const Figures = Schema.TaggedUnion({
    Circle: { radius: Schema.Finite },
    Rectangle: { width: Schema.Finite, height: Schema.Finite },
  })
  it.live("decode works inside Effect without service requirements", () =>
    Effect.gen(function* () {
      const program = Schema.decodeEffect(Figures)({
        _tag: "Rectangle",
        width: 3,
        height: 4,
      })
      const result = yield* program
      expect(result._tag).toBe("Rectangle")
      if (result._tag === "Rectangle") {
        expect(result.width * result.height).toBe(12)
      }
    }),
  )
})
