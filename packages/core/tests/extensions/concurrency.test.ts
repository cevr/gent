/**
 * Tests for extension concurrency safety:
 * - Deferred readiness in getOrSpawnActors
 * - Queued nested delivery in EventPublisher
 */
import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer } from "effect"
import {
  BaseEventStore,
  EventStore,
  type AgentEvent,
  SessionStarted,
  TurnCompleted,
} from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { CurrentExtensionSession } from "@gent/core/runtime/extensions/extension-actor-shared"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { reducerActor } from "./helpers/reducer-actor"

const sessionId = "test-session" as SessionId
const branchId = "test-branch" as BranchId

describe("extension concurrency", () => {
  describe("getOrSpawnActors Deferred readiness", () => {
    it.live("concurrent reduce calls for same session share actors", () => {
      let spawnCount = 0
      const actor = reducerActor<{ count: number }>({
        id: "counter",
        initial: { count: 0 },
        reduce: (state, event) =>
          event._tag === "SessionStarted" ? { state: { count: state.count + 1 } } : { state },
      })

      const wrappedActor = {
        ...actor,
        slots: () =>
          Effect.sync(() => {
            spawnCount++
            return {}
          }),
      }

      const extensions = [
        {
          manifest: { id: "counter", version: "1.0.0" },
          setup: { actor: wrappedActor },
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

        const [r1, r2] = yield* Effect.all(
          [runtime.publish(event, ctx), runtime.publish(event, ctx)],
          { concurrency: 2 },
        )

        expect(spawnCount).toBe(1)
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
        let first = true

        const extensions = [
          {
            manifest: { id: "ordered-restart", version: "1.0.0" },
            kind: "builtin" as const,
            sourcePath: "builtin",
            setup: {
              actor: reducerActor({
                id: "ordered-restart",
                initial: { delivered: [] as string[] },
                reduce: (state, event) => {
                  if (first && event._tag === "SessionStarted") {
                    first = false
                    throw new Error("first delivery boom")
                  }
                  delivered.push(event._tag)
                  return { state: { delivered } }
                },
              }),
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
          expect(delivered).toEqual(["SessionStarted", "TurnCompleted"])
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
})
