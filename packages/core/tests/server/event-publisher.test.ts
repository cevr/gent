import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { type AgentEvent, BaseEventStore } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { CurrentExtensionSession } from "@gent/core/runtime/extensions/extension-actor-shared"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
const runtimePlatformLayer = RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" })

const makeEvent = (tag: string, sessionId: string, branchId?: string) =>
  ({
    _tag: tag,
    sessionId: SessionId.of(sessionId),
    ...(branchId !== undefined ? { branchId: BranchId.of(branchId) } : {}),
  }) as unknown as AgentEvent

describe("EventPublisher", () => {
  test("normal publish appends and delivers", async () => {
    const delivered: string[] = []
    const persisted: string[] = []

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: (event: AgentEvent) =>
        Effect.sync(() => {
          persisted.push(event._tag)
        }),
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      publish: (event) =>
        Effect.sync(() => {
          delivered.push(event._tag)
          return false
        }),
      deriveAll: () => Effect.succeed([]),
      send: () => Effect.void,
      ask: () => Effect.die("not implemented"),
      getUiSnapshots: () => Effect.succeed([]),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, stateRuntimeLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(persisted).toEqual(["OuterEvent"])
    expect(delivered).toEqual(["OuterEvent"])
  })

  test("nested publish from extension context completes without deadlocking", async () => {
    const delivered: string[] = []
    const nestedDelivered = Effect.runSync(Deferred.make<void>())
    let publishFn: ((event: AgentEvent) => Effect.Effect<void>) | undefined

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: () => Effect.void,
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      publish: (event) =>
        Effect.gen(function* () {
          delivered.push(event._tag)
          if (event._tag === "OuterEvent" && publishFn !== undefined) {
            yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
              Effect.provideService(CurrentExtensionSession, {
                sessionId: SessionId.of("session-1"),
              }),
            )
          }
          if (event._tag === "NestedEvent") {
            yield* Deferred.succeed(nestedDelivered, void 0)
          }
          return false
        }),
      deriveAll: () => Effect.succeed([]),
      send: () => Effect.void,
      ask: () => Effect.die("not implemented"),
      getUiSnapshots: () => Effect.succeed([]),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, stateRuntimeLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      publishFn = publisher.publish
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      yield* Deferred.await(nestedDelivered)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(delivered).toEqual(["OuterEvent", "NestedEvent"])
  })

  test("nested publish from extension context still appends both events", async () => {
    const persisted: string[] = []
    const nestedDelivered = Effect.runSync(Deferred.make<void>())
    let publishFn: ((event: AgentEvent) => Effect.Effect<void>) | undefined

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: (event: AgentEvent) =>
        Effect.sync(() => {
          persisted.push(event._tag)
        }),
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      publish: (event) =>
        Effect.gen(function* () {
          if (event._tag === "OuterEvent" && publishFn !== undefined) {
            yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
              Effect.provideService(CurrentExtensionSession, {
                sessionId: SessionId.of("session-1"),
              }),
            )
          }
          if (event._tag === "NestedEvent") {
            yield* Deferred.succeed(nestedDelivered, void 0)
          }
          return false
        }),
      deriveAll: () => Effect.succeed([]),
      send: () => Effect.void,
      ask: () => Effect.die("not implemented"),
      getUiSnapshots: () => Effect.succeed([]),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, stateRuntimeLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      publishFn = publisher.publish
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      yield* Deferred.await(nestedDelivered)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(persisted).toEqual(["OuterEvent", "NestedEvent"])
  })

  test("events without sessionId skip queued delivery", async () => {
    let delivered = 0

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: () => Effect.void,
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      publish: () =>
        Effect.sync(() => {
          delivered++
          return false
        }),
      deriveAll: () => Effect.succeed([]),
      send: () => Effect.void,
      ask: () => Effect.die("not implemented"),
      getUiSnapshots: () => Effect.succeed([]),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, stateRuntimeLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      yield* publisher.publish({ _tag: "SystemEvent" } as unknown as AgentEvent)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(delivered).toBe(0)
  })

  test("bus-triggered same-session publish completes without deadlocking", async () => {
    const delivered: string[] = []
    const busNested = Effect.runSync(Deferred.make<void>())
    let publishFn: ((event: AgentEvent) => Effect.Effect<void>) | undefined

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: () => Effect.void,
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      publish: (event) =>
        Effect.gen(function* () {
          delivered.push(event._tag)
          if (event._tag === "BusNestedEvent") {
            yield* Deferred.succeed(busNested, void 0)
          }
          return false
        }),
      deriveAll: () => Effect.succeed([]),
      send: () => Effect.void,
      ask: () => Effect.die("not implemented"),
      getUiSnapshots: () => Effect.succeed([]),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const busLayer = Layer.succeed(ExtensionEventBus, {
      emit: (envelope) =>
        envelope.payload !== undefined &&
        envelope.channel === "agent:OuterEvent" &&
        publishFn !== undefined
          ? publishFn(makeEvent("BusNestedEvent", "session-1", "branch-1"))
          : Effect.void,
      on: () => Effect.succeed(() => {}),
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, stateRuntimeLayer, busLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      publishFn = publisher.publish
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      yield* Deferred.await(busNested)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(delivered).toEqual(["OuterEvent", "BusNestedEvent"])
  })
})
