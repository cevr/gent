/**
 * Tests for extension concurrency safety:
 * - Deferred readiness in getOrSpawnActors
 * - Queued nested delivery in EventPublisher
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import {
  BaseEventStore,
  EventStore,
  type AgentEvent,
  SessionStarted,
  TurnCompleted,
} from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"
import { CurrentExtensionSession } from "@gent/core/runtime/extensions/extension-actor-shared"
import { fromReducer } from "@gent/core/runtime/extensions/from-reducer"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { EventPublisherLive } from "@gent/core/server/event-publisher"

const sessionId = "test-session" as SessionId
const branchId = "test-branch" as BranchId

describe("extension concurrency", () => {
  describe("getOrSpawnActors Deferred readiness", () => {
    it.live("concurrent reduce calls for same session share actors", () => {
      let spawnCount = 0
      const { spawn } = fromReducer<{ count: number }>({
        id: "counter",
        initial: { count: 0 },
        reduce: (state, event) =>
          event._tag === "SessionStarted" ? { state: { count: state.count + 1 } } : undefined,
      })

      const wrappedSpawn: typeof spawn = (ctx) => {
        spawnCount++
        return spawn(ctx)
      }

      const extensions = [
        {
          manifest: { id: "counter", version: "1.0.0" },
          setup: { spawn: wrappedSpawn },
        },
      ] as Parameters<typeof ExtensionStateRuntime.fromExtensions>[0]

      const layer = Layer.provide(
        ExtensionStateRuntime.fromExtensions(extensions),
        ExtensionTurnControl.Test(),
      )

      return Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const event = new SessionStarted({ sessionId, branchId })
        const ctx = { sessionId, branchId }

        // Fire two reduces concurrently for the same session
        const [r1, r2] = yield* Effect.all(
          [runtime.publish(event, ctx), runtime.publish(event, ctx)],
          { concurrency: 2 },
        )

        // Actors should only be spawned once
        expect(spawnCount).toBe(1)
        // Both should see the event
        expect(r1 || r2).toBe(true)
      }).pipe(Effect.provide(layer))
    })
  })

  describe("EventPublisher queued delivery", () => {
    it.live("nested publish from extension context is queued and eventually reduced", () => {
      const delivered: string[] = []
      const nestedDelivered = Effect.runSync(Deferred.make<void>())
      let publishFromReduce: ((event: AgentEvent) => Effect.Effect<void>) | undefined

      const baseLayer = Layer.succeed(BaseEventStore, {
        publish: () => Effect.void,
        subscribe: () => Effect.void as never,
        removeSession: () => Effect.void,
      })

      const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
        publish: (event) =>
          Effect.gen(function* () {
            delivered.push(event._tag)
            if (
              event._tag === "SessionStarted" &&
              delivered.length === 1 &&
              publishFromReduce !== undefined
            ) {
              yield* publishFromReduce({
                _tag: "NestedEvent",
                sessionId,
                branchId,
              } as unknown as AgentEvent).pipe(
                Effect.provideService(CurrentExtensionSession, {
                  sessionId,
                }),
              )
            }
            if (event._tag === "NestedEvent") {
              yield* Deferred.succeed(nestedDelivered, void 0)
            }
            return false
          }),
        notifyObservers: () => Effect.void,
        deriveAll: () => Effect.succeed([]),
        send: () => Effect.void,
        ask: () => Effect.die("not implemented"),
        getUiSnapshots: () => Effect.succeed([]),
        getActorStatuses: () => Effect.succeed([]),
        terminateAll: () => Effect.void,
      })

      const layer = Layer.provide(EventPublisherLive, Layer.merge(baseLayer, stateRuntimeLayer))

      return Effect.gen(function* () {
        const publisher = yield* EventPublisher
        publishFromReduce = publisher.publish
        yield* publisher.publish(new SessionStarted({ sessionId, branchId }))
        yield* Deferred.await(nestedDelivered)
        expect(delivered).toEqual(["SessionStarted", "NestedEvent"])
      }).pipe(Effect.provide(layer))
    })

    it.live("nested publish from extension context still appends to base store", () => {
      const published: string[] = []
      const nestedDelivered = Effect.runSync(Deferred.make<void>())
      let publishFromReduce: ((event: AgentEvent) => Effect.Effect<void>) | undefined

      const baseLayer = Layer.succeed(BaseEventStore, {
        publish: (event: AgentEvent) => {
          published.push(event._tag)
          return Effect.void
        },
        subscribe: () => Effect.void as never,
        removeSession: () => Effect.void,
      })

      const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
        publish: (event) =>
          Effect.gen(function* () {
            if (
              event._tag === "SessionStarted" &&
              published.length === 1 &&
              publishFromReduce !== undefined
            ) {
              yield* publishFromReduce({
                _tag: "NestedEvent",
                sessionId,
                branchId,
              } as unknown as AgentEvent).pipe(
                Effect.provideService(CurrentExtensionSession, {
                  sessionId,
                }),
              )
            }
            if (event._tag === "NestedEvent") {
              yield* Deferred.succeed(nestedDelivered, void 0)
            }
            return false
          }),
        notifyObservers: () => Effect.void,
        deriveAll: () => Effect.succeed([]),
        send: () => Effect.void,
        ask: () => Effect.die("not implemented"),
        getUiSnapshots: () => Effect.succeed([]),
        getActorStatuses: () => Effect.succeed([]),
        terminateAll: () => Effect.void,
      })

      const layer = Layer.provide(EventPublisherLive, Layer.merge(baseLayer, stateRuntimeLayer))

      return Effect.gen(function* () {
        const publisher = yield* EventPublisher
        publishFromReduce = publisher.publish
        yield* publisher.publish(new SessionStarted({ sessionId, branchId }))
        yield* Deferred.await(nestedDelivered)
        expect(published).toEqual(["SessionStarted", "NestedEvent"])
      }).pipe(Effect.provide(layer))
    })

    it.live("runtime restart preserves same-session delivery ordering", () =>
      Effect.gen(function* () {
        const delivered: string[] = []
        let generation = 0

        const extensions = [
          {
            manifest: { id: "ordered-restart", version: "1.0.0" },
            kind: "builtin" as const,
            sourcePath: "builtin",
            setup: {
              spawn: () => {
                generation++
                const currentGeneration = generation
                return Effect.succeed({
                  id: "ordered-restart",
                  start: Effect.void,
                  publish: (event: AgentEvent) =>
                    Effect.gen(function* () {
                      if (currentGeneration === 1 && event._tag === "SessionStarted") {
                        throw new Error("first delivery boom")
                      }
                      if (event._tag === "SessionStarted") {
                        yield* Effect.sleep("20 millis")
                      }
                      delivered.push(`${currentGeneration}:${event._tag}`)
                      return true
                    }),
                  send: () => Effect.void,
                  ask: () => Effect.die("not implemented"),
                  snapshot: Effect.succeed({ state: { delivered }, epoch: delivered.length }),
                  stop: Effect.void,
                })
              },
            },
          },
        ] as Parameters<typeof ExtensionStateRuntime.fromExtensions>[0]

        const baseLayer = Layer.mergeAll(
          ExtensionStateRuntime.fromExtensions(extensions).pipe(
            Layer.provideMerge(ExtensionTurnControl.Test()),
          ),
          EventStore.Memory,
        )
        const layer = Layer.merge(baseLayer, Layer.provide(EventPublisherLive, baseLayer))

        yield* Effect.gen(function* () {
          const publisher = yield* EventPublisher
          const runtime = yield* ExtensionStateRuntime

          yield* Effect.all(
            [
              publisher.publish(new SessionStarted({ sessionId, branchId })),
              Effect.sleep("1 millis").pipe(
                Effect.andThen(
                  publisher.publish(new TurnCompleted({ sessionId, branchId, durationMs: 25 })),
                ),
              ),
            ],
            { concurrency: 2 },
          )

          const statuses = yield* runtime.getActorStatuses(sessionId)
          expect(delivered).toEqual(["2:SessionStarted", "2:TurnCompleted"])
          expect(statuses).toEqual([
            {
              extensionId: "ordered-restart",
              sessionId,
              branchId,
              status: "running",
              restartCount: 1,
            },
          ])
        }).pipe(Effect.provide(layer))
      }),
    )
  })

  describe("shared mailbox ingress", () => {
    it.live("send waits behind an earlier publish for the same session", () => {
      const order: string[] = []
      const publishGate = Effect.runSync(Deferred.make<void>())
      const Ping = ExtensionMessage("command-target", "Ping", {})

      const extensions = [
        {
          manifest: { id: "slow-publisher", version: "1.0.0" },
          kind: "builtin" as const,
          sourcePath: "builtin",
          setup: {
            actor: {
              spawn: () =>
                Effect.succeed({
                  id: "slow-publisher",
                  start: Effect.void,
                  publish: (event: AgentEvent) =>
                    event._tag === "SessionStarted"
                      ? Deferred.await(publishGate).pipe(
                          Effect.tap(() =>
                            Effect.sync(() => {
                              order.push("publish")
                            }),
                          ),
                          Effect.as(true),
                        )
                      : Effect.succeed(false),
                  send: () => Effect.void,
                  ask: () => Effect.die("not implemented"),
                  snapshot: Effect.succeed({ state: { order }, epoch: order.length }),
                  stop: Effect.void,
                }),
            },
          },
        },
        {
          manifest: { id: "command-target", version: "1.0.0" },
          kind: "builtin" as const,
          sourcePath: "builtin",
          setup: {
            actor: {
              spawn: () =>
                Effect.succeed({
                  id: "command-target",
                  start: Effect.void,
                  publish: () => Effect.succeed(false),
                  send: () =>
                    Effect.sync(() => {
                      order.push("send")
                    }),
                  ask: () => Effect.die("not implemented"),
                  snapshot: Effect.succeed({ state: { order }, epoch: order.length }),
                  stop: Effect.void,
                }),
            },
            protocols: [Ping],
          },
        },
      ] as Parameters<typeof ExtensionStateRuntime.fromExtensions>[0]

      const layer = Layer.mergeAll(
        ExtensionStateRuntime.fromExtensions(extensions).pipe(
          Layer.provideMerge(ExtensionTurnControl.Test()),
        ),
        EventStore.Memory,
      )

      return Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const publishFiber = yield* Effect.forkChild(
          runtime.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId }),
        )
        yield* Effect.sleep("1 millis")
        const sendFiber = yield* Effect.forkChild(runtime.send(sessionId, Ping(), branchId))
        yield* Effect.sleep("5 millis")

        expect(order).toEqual([])

        yield* Deferred.succeed(publishGate, void 0)
        yield* Fiber.join(publishFiber)
        yield* Fiber.join(sendFiber)

        expect(order).toEqual(["publish", "send"])
      }).pipe(Effect.provide(layer))
    })

    it.live("ask waits behind an earlier publish for the same session", () => {
      const order: string[] = []
      const publishGate = Effect.runSync(Deferred.make<void>())
      const GetStatus = ExtensionMessage.reply(
        "query-target",
        "GetStatus",
        {},
        Schema.Struct({ ok: Schema.Boolean }),
      )

      const extensions = [
        {
          manifest: { id: "slow-publisher", version: "1.0.0" },
          kind: "builtin" as const,
          sourcePath: "builtin",
          setup: {
            actor: {
              spawn: () =>
                Effect.succeed({
                  id: "slow-publisher",
                  start: Effect.void,
                  publish: (event: AgentEvent) =>
                    event._tag === "SessionStarted"
                      ? Deferred.await(publishGate).pipe(
                          Effect.tap(() =>
                            Effect.sync(() => {
                              order.push("publish")
                            }),
                          ),
                          Effect.as(true),
                        )
                      : Effect.succeed(false),
                  send: () => Effect.void,
                  ask: () => Effect.die("not implemented"),
                  snapshot: Effect.succeed({ state: { order }, epoch: order.length }),
                  stop: Effect.void,
                }),
            },
          },
        },
        {
          manifest: { id: "query-target", version: "1.0.0" },
          kind: "builtin" as const,
          sourcePath: "builtin",
          setup: {
            actor: {
              spawn: () =>
                Effect.succeed({
                  id: "query-target",
                  start: Effect.void,
                  publish: () => Effect.succeed(false),
                  send: () => Effect.void,
                  ask: () =>
                    Effect.sync(() => {
                      order.push("ask")
                      return { ok: true }
                    }),
                  snapshot: Effect.succeed({ state: { order }, epoch: order.length }),
                  stop: Effect.void,
                }),
            },
            protocols: [GetStatus],
          },
        },
      ] as Parameters<typeof ExtensionStateRuntime.fromExtensions>[0]

      const layer = Layer.mergeAll(
        ExtensionStateRuntime.fromExtensions(extensions).pipe(
          Layer.provideMerge(ExtensionTurnControl.Test()),
        ),
        EventStore.Memory,
      )

      return Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const publishFiber = yield* Effect.forkChild(
          runtime.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId }),
        )
        yield* Effect.sleep("1 millis")
        const askFiber = yield* Effect.forkChild(runtime.ask(sessionId, GetStatus(), branchId))
        yield* Effect.sleep("5 millis")

        expect(order).toEqual([])

        yield* Deferred.succeed(publishGate, void 0)
        yield* Fiber.join(publishFiber)
        const reply = yield* Fiber.join(askFiber)

        expect(reply).toEqual({ ok: true })
        expect(order).toEqual(["publish", "ask"])
      }).pipe(Effect.provide(layer))
    })

    it.live("a slow session does not block send for another session", () => {
      const order: string[] = []
      const publishGate = Effect.runSync(Deferred.make<void>())
      const Ping = ExtensionMessage("command-target", "Ping", {})
      const otherSession = "other-session" as SessionId
      const otherBranch = "other-branch" as BranchId

      const extensions = [
        {
          manifest: { id: "slow-publisher", version: "1.0.0" },
          kind: "builtin" as const,
          sourcePath: "builtin",
          setup: {
            actor: {
              spawn: () =>
                Effect.succeed({
                  id: "slow-publisher",
                  start: Effect.void,
                  publish: (event: AgentEvent) =>
                    event._tag === "SessionStarted" && event.sessionId === sessionId
                      ? Deferred.await(publishGate).pipe(Effect.as(true))
                      : Effect.succeed(false),
                  send: () => Effect.void,
                  ask: () => Effect.die("not implemented"),
                  snapshot: Effect.succeed({ state: { order }, epoch: order.length }),
                  stop: Effect.void,
                }),
            },
          },
        },
        {
          manifest: { id: "command-target", version: "1.0.0" },
          kind: "builtin" as const,
          sourcePath: "builtin",
          setup: {
            actor: {
              spawn: () =>
                Effect.succeed({
                  id: "command-target",
                  start: Effect.void,
                  publish: () => Effect.succeed(false),
                  send: () =>
                    Effect.sync(() => {
                      order.push("send-other-session")
                    }),
                  ask: () => Effect.die("not implemented"),
                  snapshot: Effect.succeed({ state: { order }, epoch: order.length }),
                  stop: Effect.void,
                }),
            },
            protocols: [Ping],
          },
        },
      ] as Parameters<typeof ExtensionStateRuntime.fromExtensions>[0]

      const layer = Layer.mergeAll(
        ExtensionStateRuntime.fromExtensions(extensions).pipe(
          Layer.provideMerge(ExtensionTurnControl.Test()),
        ),
        EventStore.Memory,
      )

      return Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const slowPublish = yield* Effect.forkChild(
          runtime.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId }),
        )
        yield* Effect.sleep("1 millis")
        yield* runtime.send(otherSession, Ping(), otherBranch)

        expect(order).toEqual(["send-other-session"])

        yield* Deferred.succeed(publishGate, void 0)
        yield* Fiber.join(slowPublish)
      }).pipe(Effect.provide(layer))
    })
  })
})
