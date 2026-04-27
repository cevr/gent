import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Layer, Ref } from "effect"
import { AgentEvent, type EventEnvelope, EventId, EventStore } from "@gent/core/domain/event"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { SubscriptionEngine } from "../../src/runtime/extensions/resource-host/subscription-engine"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { CurrentExtensionSession } from "../../src/runtime/extensions/extension-actor-shared"
import { EventPublisherLive, makeEventPublisherRouter } from "../../src/server/event-publisher"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"

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

// EventPublisher delivery is now observable through two surfaces only:
//   • EventStore.append — events become durable
//   • SubscriptionEngine.emit — extensions react via the `agent:<tag>` bus
// Tests probe these surfaces; the legacy MachineEngine.publish hook is gone.

const collectingBusLayer = (
  channels: string[],
  onChannel?: (envelope: { channel: string; payload: unknown }) => Effect.Effect<void>,
) =>
  Layer.succeed(SubscriptionEngine, {
    emit: (envelope) =>
      Effect.gen(function* () {
        channels.push(envelope.channel)
        if (onChannel !== undefined) yield* onChannel(envelope)
      }),
    on: () => Effect.succeed(() => {}),
  })

describe("EventPublisher", () => {
  test("normal publish appends and emits to subscription bus", async () => {
    const persisted: string[] = []
    const channels: string[] = []

    const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))
    const busLayer = collectingBusLayer(channels)

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, busLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(persisted).toEqual([TAG.OuterEvent])
    expect(channels).toEqual([`agent:${TAG.OuterEvent}`])
  })

  test("nested publish from bus subscriber completes without deadlocking", async () => {
    const channels: string[] = []
    const nestedDelivered = Effect.runSync(Deferred.make<void>())
    let publishFn: typeof EventPublisher.Service.publish | undefined

    const baseLayer = makeEventStoreLayer()

    // The bus subscriber re-publishes a nested event when it sees the outer.
    // This mirrors the historical worry: extension code reacting to one event
    // by publishing another on the same fiber.
    const busLayer = collectingBusLayer(channels, (envelope) =>
      Effect.gen(function* () {
        if (envelope.channel === `agent:${TAG.OuterEvent}` && publishFn !== undefined) {
          yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
            Effect.provideService(CurrentExtensionSession, {
              sessionId: SessionId.make("session-1"),
            }),
            Effect.orDie,
          )
        }
        if (envelope.channel === `agent:${TAG.NestedEvent}`) {
          yield* Deferred.succeed(nestedDelivered, void 0)
        }
      }),
    )

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, busLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      publishFn = publisher.publish
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      yield* Deferred.await(nestedDelivered)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(channels).toEqual([`agent:${TAG.OuterEvent}`, `agent:${TAG.NestedEvent}`])
  })

  test("nested publish from bus subscriber still appends both events", async () => {
    const persisted: string[] = []
    const nestedDelivered = Effect.runSync(Deferred.make<void>())
    let publishFn: typeof EventPublisher.Service.publish | undefined

    const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))

    const busLayer = Layer.succeed(SubscriptionEngine, {
      emit: (envelope) =>
        Effect.gen(function* () {
          if (envelope.channel === `agent:${TAG.OuterEvent}` && publishFn !== undefined) {
            yield* publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(
              Effect.provideService(CurrentExtensionSession, {
                sessionId: SessionId.make("session-1"),
              }),
              Effect.orDie,
            )
          }
          if (envelope.channel === `agent:${TAG.NestedEvent}`) {
            yield* Deferred.succeed(nestedDelivered, void 0)
          }
        }),
      on: () => Effect.succeed(() => {}),
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, busLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      publishFn = publisher.publish
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      yield* Deferred.await(nestedDelivered)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(persisted).toEqual([TAG.OuterEvent, TAG.NestedEvent])
  })

  test("declared pulseTags trigger ExtensionStateChanged for each matching event", async () => {
    // After W10-PhaseB, FSM transitions are gone — the only pulse path is
    // `pulseTags` declared at extension-load time. `event-publisher.ts`
    // looks up subscribers for each event's tag and emits one
    // `ExtensionStateChanged` per declared subscriber, regardless of what
    // the MachineEngine returns.
    const persisted: string[] = []
    const pulseTagsRegistryLayer = ExtensionRegistry.fromResolved(
      resolveExtensions([
        {
          manifest: { id: ExtensionId.make("pulse-only-ext") },
          scope: "builtin",
          sourcePath: "builtin",
          contributions: { pulseTags: [TAG.OuterEvent, TAG.NestedEvent] },
        },
      ]),
    )

    const baseLayer = makeEventStoreLayer((event) => {
      persisted.push(event._tag)
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(baseLayer, pulseTagsRegistryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
      yield* publisher.publish(makeEvent("NestedEvent", "session-1", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(persisted).toEqual([
      TAG.OuterEvent,
      "ExtensionStateChanged",
      TAG.NestedEvent,
      "ExtensionStateChanged",
    ])
  })

  test("publish yields before bus.emit so concurrent fibers see the broadcast", async () => {
    // Regression: deliverInner has an `Effect.yieldNow` between
    // baseEventStore.broadcast and bus.emit. The yield lets fibers blocked
    // on the broadcast (the agent-loop driver subscribed via EventStore)
    // take a step before extension subscribers see the event. Without it,
    // sites that publish on the same fiber that drives the loop (e.g.
    // turn-control commands) skip the Idle → Running edge.
    //
    // We model the contract directly: a forked fiber released by the
    // broadcast hook sets a Ref. The bus.emit subscriber then reads the
    // Ref. If the yield happens, the Ref is "ran" by the time bus.emit
    // runs; if removed, bus.emit sees the initial "unset".
    const broadcastReleased = Effect.runSync(Deferred.make<void>())
    const observedAtEmit = Effect.runSync(Ref.make<"unset" | "ran">("unset"))
    const refAtEmit: Array<"unset" | "ran"> = []

    const customEventStore = Layer.succeed(EventStore, {
      append: (event) =>
        Effect.succeed({ id: EventId.make(1), event, createdAt: Date.now() } as EventEnvelope),
      broadcast: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(broadcastReleased, void 0)
        }),
      publish: () => Effect.void,
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const busLayer = Layer.succeed(SubscriptionEngine, {
      emit: () =>
        Effect.gen(function* () {
          const value = yield* Ref.get(observedAtEmit)
          refAtEmit.push(value)
        }),
      on: () => Effect.succeed(() => {}),
    })

    const layer = Layer.provide(
      EventPublisherLive,
      Layer.mergeAll(customEventStore, busLayer, registryLayer, runtimePlatformLayer),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.await(broadcastReleased)
          yield* Ref.set(observedAtEmit, "ran")
        }),
      )
      yield* publisher.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(refAtEmit).toEqual(["ran"])
  })
})

describe("EventPublisher per-cwd router", () => {
  test("per-cwd SubscriptionEngine receives only its cwd's events", async () => {
    const primaryBusChannels: string[] = []
    const secondaryBusChannels: string[] = []

    const primaryCwd = "/primary"
    const secondaryCwd = "/secondary"
    const sessionA = SessionId.make("session-primary")
    const sessionB = SessionId.make("session-secondary")

    const baseLayer = makeEventStoreLayer()

    // SessionProfile still types `extensionStateRuntime: MachineEngineService`,
    // but EventPublisher's router no longer reads it. Stub it for shape only.
    const stubEngine = {
      send: () => Effect.void,
      execute: () => Effect.die("not implemented") as never,
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
      extensionStateRuntime: stubEngine,
      actorEngine: {} as never,
      receptionist: {} as never,
      layerContext: Context.empty(),
      subscriptionEngine: secondaryBus,
      baseSections: [],
      instructions: "",
      pulseByTag: new Map(),
    } satisfies SessionProfile

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
    const primaryBusChannels: string[] = []
    const persisted: string[] = []

    const primaryCwd = "/primary"
    const sessionB = SessionId.make("session-secondary")

    const baseLayer = makeEventStoreLayer((event) => persisted.push(event._tag))

    // Primary bus probe — would receive events if router fell back to it
    const primaryBusLayer = Layer.succeed(SubscriptionEngine, {
      emit: (envelope) =>
        Effect.sync(() => {
          primaryBusChannels.push(envelope.channel)
        }),
      on: () => Effect.succeed(() => {}),
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
        primaryBusLayer,
        registryLayer,
        cwdRegistryLayer,
        runtimePlatformLayer,
      ),
    )

    await Effect.gen(function* () {
      const publisher = yield* EventPublisher
      // handle.profileCache is never set — event should persist but
      // NOT fan out through the primary bus (fail closed, not fall-through)
      yield* publisher.publish(makeEvent("FallbackEvent", "session-secondary", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    // Event was persisted to storage
    expect(persisted).toEqual([TAG.FallbackEvent])
    // Primary bus did NOT receive it (fail closed, not fall-through)
    expect(primaryBusChannels).toEqual([])
  })
})
