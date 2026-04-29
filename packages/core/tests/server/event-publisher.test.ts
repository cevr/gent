import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { AgentEvent, type EventEnvelope, EventId, EventStore } from "@gent/core/domain/event"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { EventPublisherLive, makeEventPublisherRouter } from "../../src/server/event-publisher"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
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
const makeEventStoreLayer = (onAppend?: (event: AgentEvent) => void) => {
  let nextId = 0
  const append = (event: AgentEvent) =>
    Effect.sync(() => {
      onAppend?.(event)
      nextId += 1
      return {
        id: EventId.make(nextId),
        event,
        createdAt: Date.now(),
      } as EventEnvelope
    })
  return Layer.succeed(EventStore, {
    append,
    broadcast: () => Effect.void,
    publish: (event: AgentEvent) =>
      Effect.gen(function* () {
        yield* append(event)
      }),
    subscribe: () => Effect.void as never,
    removeSession: () => Effect.void,
  })
}
// EventPublisher delivery is observable through EventStore append/broadcast.
describe("EventPublisher", () => {
  it.live("normal publish appends and broadcasts the committed event", () =>
    Effect.gen(function* () {
      const persisted: string[] = []
      const broadcasted: string[] = []
      let nextId = 0
      const baseLayer = Layer.succeed(EventStore, {
        append: (event: AgentEvent) =>
          Effect.sync(() => {
            persisted.push(event._tag)
            nextId += 1
            return { id: EventId.make(nextId), event, createdAt: Date.now() } as EventEnvelope
          }),
        broadcast: (envelope: EventEnvelope) =>
          Effect.sync(() => {
            broadcasted.push(envelope.event._tag)
          }),
        publish: () => Effect.void,
        subscribe: () => Effect.void as never,
        removeSession: () => Effect.void,
      })
      const layer = Layer.provide(EventPublisherLive, baseLayer)
      yield* Effect.promise(() =>
        Effect.gen(function* () {
          const publisher = yield* EventPublisher
          yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
        }).pipe(Effect.provide(layer), Effect.runPromise),
      )
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
      const customEventStore = Layer.succeed(EventStore, {
        append: (event) =>
          Effect.succeed({ id: EventId.make(1), event, createdAt: Date.now() } as EventEnvelope),
        broadcast: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(broadcastStarted, void 0)
            yield* Deferred.await(releaseBroadcast)
          }),
        publish: () => Effect.void,
        subscribe: () => Effect.void as never,
        removeSession: () => Effect.void,
      })
      const layer = Layer.provide(EventPublisherLive, customEventStore)
      yield* Effect.promise(() =>
        Effect.gen(function* () {
          const publisher = yield* EventPublisher
          const fiber = yield* Effect.forkScoped(
            publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1")),
          )
          yield* Deferred.await(broadcastStarted)
          const early = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("50 millis"))
          expect(early._tag).toBe("None")
          yield* Deferred.succeed(releaseBroadcast, void 0)
          yield* Fiber.join(fiber)
        }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise),
      )
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
        createdAt: Date.now(),
      } as EventEnvelope
      const customEventStore = Layer.succeed(EventStore, {
        append: (event) => Effect.succeed({ ...envelope, event }),
        broadcast: () =>
          Effect.gen(function* () {
            yield* Ref.update(broadcastCount, (count) => count + 1)
            yield* Deferred.succeed(firstBroadcastStarted, void 0)
            yield* Deferred.await(releaseFirstBroadcast)
          }),
        publish: () => Effect.void,
        subscribe: () => Effect.void as never,
        removeSession: () => Effect.void,
      })
      const layer = Layer.provide(EventPublisherLive, customEventStore)
      yield* Effect.promise(() =>
        Effect.gen(function* () {
          const publisher = yield* EventPublisher
          const first = yield* Effect.forkScoped(publisher.deliver(envelope))
          yield* Deferred.await(firstBroadcastStarted)
          const second = yield* Effect.forkScoped(publisher.deliver(envelope))
          expect(yield* Ref.get(broadcastCount)).toBe(1)
          yield* Deferred.succeed(releaseFirstBroadcast, void 0)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          expect(yield* Ref.get(broadcastCount)).toBe(1)
        }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise),
      )
    }),
  )
})
describe("EventPublisher per-cwd router", () => {
  it.live("unset handle persists event but skips runtime dispatch (fail closed)", () =>
    Effect.gen(function* () {
      const persisted: string[] = []
      const primaryCwd = "/primary"
      const sessionB = SessionId.make("session-secondary")
      const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))
      // Session maps to a different cwd, but handle is never set
      const cwdRegistryLayer = SessionCwdRegistry.Test(new Map([[sessionB, "/other-cwd"]]))
      const runtimePlatformLayer = RuntimePlatform.Test({
        cwd: primaryCwd,
        home: "/tmp",
        platform: "test",
      })
      const { layer: routerLayer } = makeEventPublisherRouter()
      const layer = Layer.provide(
        routerLayer,
        Layer.mergeAll(baseLayer, cwdRegistryLayer, runtimePlatformLayer),
      )
      yield* Effect.promise(() =>
        Effect.gen(function* () {
          const publisher = yield* EventPublisher
          // handle.profileCache is never set — event should persist but
          // NOT fall through to the primary profile runtime.
          yield* publisher.publish(makeEvent("FallbackEvent", "session-secondary", "branch-1"))
        }).pipe(Effect.provide(layer), Effect.runPromise),
      )
      // Event was persisted to storage
      expect(persisted).toEqual([TAG.FallbackEvent])
    }),
  )
})
