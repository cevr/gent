import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import {
  AgentEvent,
  type EventEnvelope,
  EventId,
  EventStore,
  type EventStoreService,
  makeSerializedEventDelivery,
} from "@gent/core-internal/domain/event"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { dateFromMillis } from "@gent/core-internal/domain/message"
import { EventPublisher, EventPublisherLive } from "@gent/core-internal/domain/event-publisher"

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
} as const
type SyntheticTag = keyof typeof TAG_MAP
type RealTag = (typeof TAG_MAP)[SyntheticTag]
const toBranchId = (branchId: string | BranchId | undefined): BranchId => {
  if (branchId === undefined) return BranchId.make("default-branch")
  if (typeof branchId === "string") return BranchId.make(branchId)
  return branchId
}
const makeEvent = (
  tag: SyntheticTag,
  sessionId: string | SessionId,
  branchId?: string | BranchId,
): AgentEvent => {
  const realTag = TAG_MAP[tag]
  const sid = typeof sessionId === "string" ? SessionId.make(sessionId) : sessionId
  const bid = toBranchId(branchId)
  const base = {
    _tag: realTag,
    sessionId: sid,
    branchId: bid,
    toolCallId: ToolCallId.make(`${tag}-${sid}`),
    toolName: tag,
  }
  switch (realTag) {
    case "ToolCallStarted":
      return AgentEvent.ToolCallStarted.make(base)
    case "ToolCallSucceeded":
      return AgentEvent.ToolCallSucceeded.make(base)
    case "ToolCallFailed":
      return AgentEvent.ToolCallFailed.make(base)
  }
}
// Tests reference these by their real tag names in expectations.
const TAG = TAG_MAP satisfies Record<SyntheticTag, RealTag>

const makeEventStoreLayer = (
  input: Pick<EventStoreService, "append" | "broadcast">,
): Layer.Layer<EventStore> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const deliver = yield* makeSerializedEventDelivery(input.broadcast)
      const service: EventStoreService = {
        append: input.append,
        broadcast: input.broadcast,
        deliver,
        publish: Effect.fn("TestEventStore.publish")(function* (event) {
          const envelope = yield* input.append(event)
          yield* deliver(envelope)
        }),
        subscribe: () => Effect.die("subscribe not exercised in EventPublisher tests") as never,
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
            return { id: EventId.make(nextId), event, createdAt: FIXED_NOW_MILLIS } as EventEnvelope
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
          } as EventEnvelope),
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
      } as EventEnvelope
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
      } as EventEnvelope
      const customEventStore = makeEventStoreLayer({
        append: (event) => Effect.succeed({ ...envelope, event }),
        broadcast: () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) => (count === 1 ? Effect.die("broadcast defect") : Effect.void)),
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
            return { id: EventId.make(nextId), event, createdAt: FIXED_NOW_MILLIS } as EventEnvelope
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
