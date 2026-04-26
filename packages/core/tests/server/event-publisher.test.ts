import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AgentEvent, type EventEnvelope, EventId, EventStore } from "@gent/core/domain/event"
import { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { SubscriptionEngine } from "../../src/runtime/extensions/resource-host/subscription-engine"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { CurrentExtensionSession } from "../../src/runtime/extensions/extension-actor-shared"
import { EventPublisherLive, makeEventPublisherRouter } from "../../src/server/event-publisher"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"
import { CurrentMachinePublishListener } from "../../src/runtime/extensions/resource-host/machine-publish-listener"

const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
const runtimePlatformLayer = RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" })

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

    expect(persisted).toEqual([TAG.OuterEvent])
    expect(delivered).toEqual([TAG.OuterEvent])
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
          if (event._tag === TAG.OuterEvent && publishFn !== undefined) {
            yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
              Effect.provideService(CurrentExtensionSession, {
                sessionId: SessionId.make("session-1"),
              }),
            )
          }
          if (event._tag === TAG.NestedEvent) {
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

    expect(delivered).toEqual([TAG.OuterEvent, TAG.NestedEvent])
  })

  test("nested publish from extension context still appends both events", async () => {
    const persisted: string[] = []
    const nestedDelivered = Effect.runSync(Deferred.make<void>())
    let publishFn: ((event: AgentEvent) => Effect.Effect<void>) | undefined

    const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.gen(function* () {
          if (event._tag === TAG.OuterEvent && publishFn !== undefined) {
            yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
              Effect.provideService(CurrentExtensionSession, {
                sessionId: SessionId.make("session-1"),
              }),
            )
          }
          if (event._tag === TAG.NestedEvent) {
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

    expect(persisted).toEqual([TAG.OuterEvent, TAG.NestedEvent])
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
          if (event._tag === TAG.BusNestedEvent) {
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
        envelope.channel === `agent:${TAG.OuterEvent}` &&
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

    expect(delivered).toEqual([TAG.OuterEvent, TAG.BusNestedEvent])
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
          contributions: { pulseTags: [TAG.OuterEvent, TAG.NestedEvent] },
        },
      ]),
    )

    const baseLayer = makeEventStoreLayer((event) => {
      persisted.push(event._tag)
      if (event._tag === "ExtensionStateChanged" && persisted.includes(TAG.NestedEvent)) {
        Effect.runSync(Deferred.succeed(nestedPulse, void 0).pipe(Effect.ignore))
      }
    })

    const stateRuntimeLayer = Layer.succeed(MachineEngine, {
      publish: (event) =>
        Effect.gen(function* () {
          const listener = yield* CurrentMachinePublishListener
          if (event._tag === TAG.OuterEvent) {
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
          if (event._tag === TAG.NestedEvent) {
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
      TAG.OuterEvent,
      "ExtensionStateChanged",
      TAG.NestedEvent,
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
      yield* publisher.publish(makeEvent("PrimaryEvent", sessionA, branchA))

      // Publish event for session in secondary cwd
      yield* publisher.publish(makeEvent("SecondaryEvent", sessionB, branchB))
    }).pipe(Effect.provide(Layer.merge(layer, profileCacheLayer)), Effect.runPromise)

    // Primary engine got only the primary event
    expect(primaryDelivered).toEqual([TAG.PrimaryEvent])
    // Secondary engine got only the secondary event
    expect(secondaryDelivered).toEqual([TAG.SecondaryEvent])
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
    expect(primaryBusChannels).toEqual([`agent:${TAG.EventA}`])
    // Secondary bus got only secondary cwd's event
    expect(secondaryBusChannels).toEqual([`agent:${TAG.EventB}`])
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
    expect(persisted).toEqual([TAG.FallbackEvent])
    // Primary engine did NOT receive it (fail closed, not fall-through)
    expect(primaryDelivered).toEqual([])
  })
})
