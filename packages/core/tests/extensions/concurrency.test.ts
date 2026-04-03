/**
 * Tests for extension concurrency safety:
 * - Deferred readiness in getOrSpawnActors
 * - Queued nested delivery in EventPublisher
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer } from "effect"
import { BaseEventStore, type AgentEvent, SessionStarted } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
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
  })
})
