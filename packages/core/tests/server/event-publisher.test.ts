import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { type AgentEvent, type EventEnvelope, EventId, EventStore } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { SubscriptionEngine } from "../../src/runtime/extensions/resource-host/subscription-engine"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { CurrentExtensionSession } from "../../src/runtime/extensions/extension-actor-shared"
import { EventPublisherLive, makeEventPublisherRouter } from "@gent/core/server/event-publisher"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { CurrentMachinePublishListener } from "../../src/runtime/extensions/resource-host/machine-publish-listener"

const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
const runtimePlatformLayer = RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" })

const makeEvent = (tag: string, sessionId: string, branchId?: string) =>
  ({
    _tag: tag,
    sessionId: SessionId.make(sessionId),
    ...(branchId !== undefined ? { branchId: BranchId.make(branchId) } : {}),
  }) as unknown as AgentEvent

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

describe("EventPublisher", () => {
  test("normal publish appends and delivers", async () => {
    const delivered: string[] = []
    const persisted: string[] = []

    const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.sync(() => {
          delivered.push(event._tag)
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
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

    const baseLayer = makeEventStoreLayer()

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.gen(function* () {
          delivered.push(event._tag)
          if (event._tag === "OuterEvent" && publishFn !== undefined) {
            yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
              Effect.provideService(CurrentExtensionSession, {
                sessionId: SessionId.make("session-1"),
              }),
            )
          }
          if (event._tag === "NestedEvent") {
            yield* Deferred.succeed(nestedDelivered, void 0)
          }
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
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

    const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.gen(function* () {
          if (event._tag === "OuterEvent" && publishFn !== undefined) {
            yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
              Effect.provideService(CurrentExtensionSession, {
                sessionId: SessionId.make("session-1"),
              }),
            )
          }
          if (event._tag === "NestedEvent") {
            yield* Deferred.succeed(nestedDelivered, void 0)
          }
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
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

    const baseLayer = makeEventStoreLayer()

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: () =>
        Effect.sync(() => {
          delivered++
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
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

    const baseLayer = makeEventStoreLayer()

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.gen(function* () {
          delivered.push(event._tag)
          if (event._tag === "BusNestedEvent") {
            yield* Deferred.succeed(busNested, void 0)
          }
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const busLayer = Layer.succeed(SubscriptionEngine, {
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

  test("nested publish still emits ExtensionStateChanged pulses when transitions are async", async () => {
    const persisted: string[] = []
    const nestedPulse = Effect.runSync(Deferred.make<void>())
    let publishFn: ((event: AgentEvent) => Effect.Effect<void>) | undefined
    const pulseTagsRegistryLayer = ExtensionRegistry.fromResolved(
      resolveExtensions([
        {
          manifest: { id: "pulse-only-ext" },
          scope: "builtin",
          sourcePath: "builtin",
          contributions: { pulseTags: ["OuterEvent", "NestedEvent"] },
        },
      ]),
    )

    const baseLayer = makeEventStoreLayer((event) => {
      persisted.push(event._tag)
      if (event._tag === "ExtensionStateChanged" && persisted.includes("NestedEvent")) {
        Effect.runSync(Deferred.succeed(nestedPulse, void 0).pipe(Effect.ignore))
      }
    })

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.gen(function* () {
          const listener = yield* CurrentMachinePublishListener
          if (event._tag === "OuterEvent") {
            yield* listener?.([]) ?? Effect.void
            if (publishFn !== undefined) {
              yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
                Effect.provideService(CurrentExtensionSession, {
                  sessionId: SessionId.make("session-1"),
                }),
              )
            }
            return [] as ReadonlyArray<string>
          }
          if (event._tag === "NestedEvent") {
            yield* listener?.([]) ?? Effect.void
            return [] as ReadonlyArray<string>
          }
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, stateRuntimeLayer, pulseTagsRegistryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      publishFn = publisher.publish
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      yield* Deferred.await(nestedPulse)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(persisted).toEqual([
      "OuterEvent",
      "ExtensionStateChanged",
      "NestedEvent",
      "ExtensionStateChanged",
    ])
  })
})

describe("EventPublisher per-cwd router", () => {
  test("two cwds firing events dispatch through different MachineEngines", async () => {
    const primaryDelivered: string[] = []
    const secondaryDelivered: string[] = []

    const primaryCwd = "/primary"
    const secondaryCwd = "/secondary"
    const sessionA = SessionId.make("session-primary")
    const sessionB = SessionId.make("session-secondary")
    const branchA = BranchId.make("branch-primary")
    const branchB = BranchId.make("branch-secondary")

    const baseLayer = makeEventStoreLayer()

    // Primary MachineEngine tracks events dispatched to it
    const primaryEngineLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.sync(() => {
          primaryDelivered.push(event._tag)
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    // Secondary MachineEngine tracks events dispatched to it
    const secondaryEngine = {
      publish: (event: AgentEvent) =>
        Effect.sync(() => {
          secondaryDelivered.push(event._tag)
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented") as never,
      getActorStatuses: () => Effect.succeed([] as ReadonlyArray<never>),
      terminateAll: () => Effect.void,
    }

    // Build a SessionProfile for the secondary cwd. Only the fields
    // used by the router's inner publish path need real values: the
    // engine, registry's getResolved, and subscriptionEngine.
    const secondaryResolved = resolveExtensions([])
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
    const secondaryProfile = {
      cwd: secondaryCwd,
      extensions: [],
      resolved: secondaryResolved,
      permissionService: {
        check: () => Effect.succeed("allowed" as const),
        addRule: () => Effect.void,
        removeRule: () => Effect.void,
        getRules: () => Effect.succeed([]),
      },
      registryService: { getResolved: () => secondaryResolved } as never,
      driverRegistryService: {} as never,
      extensionStateRuntime: secondaryEngine,
      subscriptionEngine: undefined,
      baseSections: [],
      instructions: "",
    } as SessionProfile

    // SessionCwdRegistry knows which session belongs to which cwd
    const cwdRegistryLayer = SessionCwdRegistry.Test(
      new Map([
        [sessionA, primaryCwd],
        [sessionB, secondaryCwd],
      ]),
    )

    const profileCacheLayer = SessionProfileCache.Test(new Map([[secondaryCwd, secondaryProfile]]))

    const runtimePlatformLayer = RuntimePlatform.Test({
      cwd: primaryCwd,
      home: "/tmp",
      platform: "test",
    })

    const { handle, layer: routerLayer } = makeEventPublisherRouter()

    const layer = Layer.provide(
      routerLayer,
      Layer.mergeAll(
        baseLayer,
        primaryEngineLayer,
        registryLayer,
        cwdRegistryLayer,
        runtimePlatformLayer,
      ),
    )

    await Effect.gen(function* () {
      // Set the profile cache handle (simulates what createDependencies does)
      const profileCache = yield* SessionProfileCache
      handle.profileCache = profileCache

      const publisher = yield* EventPublisher

      // Publish event for session in primary cwd
      yield* publisher.publish({
        _tag: "PrimaryEvent",
        sessionId: sessionA,
        branchId: branchA,
      } as unknown as AgentEvent)

      // Publish event for session in secondary cwd
      yield* publisher.publish({
        _tag: "SecondaryEvent",
        sessionId: sessionB,
        branchId: branchB,
      } as unknown as AgentEvent)
    }).pipe(Effect.provide(Layer.merge(layer, profileCacheLayer)), Effect.runPromise)

    // Primary engine got only the primary event
    expect(primaryDelivered).toEqual(["PrimaryEvent"])
    // Secondary engine got only the secondary event
    expect(secondaryDelivered).toEqual(["SecondaryEvent"])
  })

  test("per-cwd SubscriptionEngine receives only its cwd's events", async () => {
    const primaryBusChannels: string[] = []
    const secondaryBusChannels: string[] = []

    const primaryCwd = "/primary"
    const secondaryCwd = "/secondary"
    const sessionA = SessionId.make("session-primary")
    const sessionB = SessionId.make("session-secondary")

    const baseLayer = makeEventStoreLayer()

    const noopEngine = {
      publish: () => Effect.succeed([] as ReadonlyArray<string>),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented") as never,
      getActorStatuses: () => Effect.succeed([] as ReadonlyArray<never>),
      terminateAll: () => Effect.void,
    }

    // Primary bus tracks channels it receives
    const primaryBusLayer = Layer.succeed(SubscriptionEngine, {
      emit: (envelope) =>
        Effect.sync(() => {
          primaryBusChannels.push(envelope.channel)
        }),
      on: () => Effect.succeed(() => {}),
    })

    // Secondary bus tracks channels it receives
    const secondaryBus = {
      emit: (envelope: { channel: string }) =>
        Effect.sync(() => {
          secondaryBusChannels.push(envelope.channel)
        }),
      on: () => Effect.succeed(() => {}),
    }

    const secondaryResolved = resolveExtensions([])
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture owns intentionally partial typed values
    const secondaryProfile = {
      cwd: secondaryCwd,
      extensions: [],
      resolved: secondaryResolved,
      permissionService: {
        check: () => Effect.succeed("allowed" as const),
        addRule: () => Effect.void,
        removeRule: () => Effect.void,
        getRules: () => Effect.succeed([]),
      },
      registryService: { getResolved: () => secondaryResolved } as never,
      driverRegistryService: {} as never,
      extensionStateRuntime: noopEngine,
      subscriptionEngine: secondaryBus,
      baseSections: [],
      instructions: "",
    } as SessionProfile

    const cwdRegistryLayer = SessionCwdRegistry.Test(
      new Map([
        [sessionA, primaryCwd],
        [sessionB, secondaryCwd],
      ]),
    )

    const profileCacheLayer = SessionProfileCache.Test(new Map([[secondaryCwd, secondaryProfile]]))
    const runtimePlatformLayer = RuntimePlatform.Test({
      cwd: primaryCwd,
      home: "/tmp",
      platform: "test",
    })

    const primaryEngineLayer = Layer.succeed(MachineEngine, noopEngine)
    const { handle, layer: routerLayer } = makeEventPublisherRouter()

    const layer = Layer.provide(
      routerLayer,
      Layer.mergeAll(
        baseLayer,
        primaryEngineLayer,
        primaryBusLayer,
        registryLayer,
        cwdRegistryLayer,
        runtimePlatformLayer,
      ),
    )

    await Effect.gen(function* () {
      const profileCache = yield* SessionProfileCache
      handle.profileCache = profileCache
      const publisher = yield* EventPublisher

      yield* publisher.publish(makeEvent("EventA", "session-primary", "branch-1"))
      yield* publisher.publish(makeEvent("EventB", "session-secondary", "branch-2"))
    }).pipe(Effect.provide(Layer.merge(layer, profileCacheLayer)), Effect.runPromise)

    // Primary bus got only primary cwd's event
    expect(primaryBusChannels).toEqual(["agent:EventA"])
    // Secondary bus got only secondary cwd's event
    expect(secondaryBusChannels).toEqual(["agent:EventB"])
  })

  test("unset handle persists event but skips runtime dispatch (fail closed)", async () => {
    const primaryDelivered: string[] = []
    const persisted: string[] = []

    const primaryCwd = "/primary"
    const sessionB = SessionId.make("session-secondary")

    const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))

    const primaryEngineLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.sync(() => {
          primaryDelivered.push(event._tag)
          return [] as ReadonlyArray<string>
        }),
      send: () => Effect.void,
      execute: () => Effect.die("not implemented"),
      getActorStatuses: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

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
      Layer.mergeAll(
        baseLayer,
        primaryEngineLayer,
        registryLayer,
        cwdRegistryLayer,
        runtimePlatformLayer,
      ),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      // handle.profileCache is never set — event should persist but
      // NOT dispatch through primary engine (fail closed)
      yield* publisher.publish(makeEvent("FallbackEvent", "session-secondary", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    // Event was persisted to storage
    expect(persisted).toEqual(["FallbackEvent"])
    // Primary engine did NOT receive it (fail closed, not fall-through)
    expect(primaryDelivered).toEqual([])
  })
})
