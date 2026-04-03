/**
 * Tests for extension concurrency safety:
 * - Deferred readiness in getOrSpawnActors
 * - Re-entrance guard in ReducingEventStore
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import {
  BaseEventStore,
  EventStore,
  type AgentEvent,
  SessionStarted,
} from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { fromReducer } from "@gent/core/runtime/extensions/from-reducer"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { makeReducingEventStore } from "@gent/core/server/dependencies"

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

  describe("ReducingEventStore re-entrance guard", () => {
    it.live("nested publish during reduce skips reduction", () => {
      const reduceCount = { value: 0 }
      let publishFromReduce: ((event: AgentEvent) => Effect.Effect<void>) | undefined

      const baseLayer = Layer.succeed(BaseEventStore, {
        publish: () => Effect.void,
        subscribe: () => Effect.void as never,
        removeSession: () => Effect.void,
      })

      const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
        publish: () => {
          reduceCount.value++
          // On first reduce, re-enter by publishing another event
          if (reduceCount.value === 1 && publishFromReduce !== undefined) {
            return publishFromReduce(new SessionStarted({ sessionId, branchId })).pipe(
              Effect.as(false),
            )
          }
          return Effect.succeed(false)
        },
        notifyObservers: () => Effect.void,
        deriveAll: () => Effect.succeed([]),
        send: () => Effect.void,
        ask: () => Effect.die("not implemented"),
        getUiSnapshots: () => Effect.succeed([]),
        terminateAll: () => Effect.void,
      })

      const layer = Layer.provide(makeReducingEventStore, Layer.merge(baseLayer, stateRuntimeLayer))

      return Effect.gen(function* () {
        const store = yield* EventStore
        publishFromReduce = store.publish
        yield* store.publish(new SessionStarted({ sessionId, branchId }))

        // Only 1 reduce call — the nested publish was skipped
        expect(reduceCount.value).toBe(1)
      }).pipe(Effect.provide(layer))
    })

    it.live("re-entrant publish still persists to base store", () => {
      const published: string[] = []
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
        publish: () => {
          if (published.length === 1 && publishFromReduce !== undefined) {
            return publishFromReduce({
              _tag: "NestedEvent",
              sessionId,
              branchId,
            } as unknown as AgentEvent).pipe(Effect.as(false))
          }
          return Effect.succeed(false)
        },
        notifyObservers: () => Effect.void,
        deriveAll: () => Effect.succeed([]),
        send: () => Effect.void,
        ask: () => Effect.die("not implemented"),
        getUiSnapshots: () => Effect.succeed([]),
        terminateAll: () => Effect.void,
      })

      const layer = Layer.provide(makeReducingEventStore, Layer.merge(baseLayer, stateRuntimeLayer))

      return Effect.gen(function* () {
        const store = yield* EventStore
        publishFromReduce = store.publish
        yield* store.publish(new SessionStarted({ sessionId, branchId }))

        // Both events persisted to base store
        expect(published).toEqual(["SessionStarted", "NestedEvent"])
      }).pipe(Effect.provide(layer))
    })
  })
})
