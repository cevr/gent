import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BaseEventStore, EventStore, type AgentEvent } from "@gent/core/domain/event"
import { makeReducingEventStore } from "@gent/core/server/dependencies"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

// Minimal event for testing
const makeEvent = (tag: string, sessionId: string, branchId?: string) =>
  ({
    _tag: tag,
    sessionId: sessionId as SessionId,
    ...(branchId !== undefined ? { branchId: branchId as BranchId } : {}),
  }) as unknown as AgentEvent

describe("ReducingEventStore", () => {
  test("normal publish runs reduce", async () => {
    const reduceCount = { value: 0 }

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: () => Effect.void,
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      reduce: () => {
        reduceCount.value++
        return Effect.succeed(false)
      },
      deriveAll: () => Effect.succeed([]),
      handleIntent: () => Effect.void,
      getUiSnapshots: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(makeReducingEventStore, Layer.merge(baseLayer, stateRuntimeLayer))

    await Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.publish(makeEvent("TestEvent", "session-1", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(reduceCount.value).toBe(1)
  })

  test("re-entrant publish during reduce skips nested reduce", async () => {
    const reduceCount = { value: 0 }
    let publishFn: ((event: AgentEvent) => Effect.Effect<void>) | undefined

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: () => Effect.void,
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      reduce: () => {
        reduceCount.value++
        // Re-enter: publish another event from inside reduce
        if (reduceCount.value === 1 && publishFn !== undefined) {
          return publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(Effect.as(false))
        }
        return Effect.succeed(false)
      },
      deriveAll: () => Effect.succeed([]),
      handleIntent: () => Effect.void,
      getUiSnapshots: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(makeReducingEventStore, Layer.merge(baseLayer, stateRuntimeLayer))

    await Effect.gen(function* () {
      const store = yield* EventStore
      publishFn = store.publish
      yield* store.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    // Reduce should only be called once — the nested publish skips reduce
    expect(reduceCount.value).toBe(1)
  })

  test("re-entrant publish still writes to base store", async () => {
    const published: string[] = []

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: (event: AgentEvent) => {
        published.push(event._tag)
        return Effect.void
      },
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    let publishFn: ((event: AgentEvent) => Effect.Effect<void>) | undefined

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      reduce: () => {
        if (published.length === 1 && publishFn !== undefined) {
          return publishFn(makeEvent("NestedEvent", "session-1", "branch-1")).pipe(Effect.as(false))
        }
        return Effect.succeed(false)
      },
      deriveAll: () => Effect.succeed([]),
      handleIntent: () => Effect.void,
      getUiSnapshots: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(makeReducingEventStore, Layer.merge(baseLayer, stateRuntimeLayer))

    await Effect.gen(function* () {
      const store = yield* EventStore
      publishFn = store.publish
      yield* store.publish(makeEvent("OuterEvent", "session-1", "branch-1"))
    }).pipe(Effect.provide(layer), Effect.runPromise)

    // Both events should be written to base store
    expect(published).toEqual(["OuterEvent", "NestedEvent"])
  })

  test("events without sessionId skip reduce", async () => {
    const reduceCount = { value: 0 }

    const baseLayer = Layer.succeed(BaseEventStore, {
      publish: () => Effect.void,
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    })

    const stateRuntimeLayer = Layer.succeed(ExtensionStateRuntime, {
      reduce: () => {
        reduceCount.value++
        return Effect.succeed(false)
      },
      deriveAll: () => Effect.succeed([]),
      handleIntent: () => Effect.void,
      getUiSnapshots: () => Effect.succeed([]),
      terminateAll: () => Effect.void,
    })

    const layer = Layer.provide(makeReducingEventStore, Layer.merge(baseLayer, stateRuntimeLayer))

    await Effect.gen(function* () {
      const store = yield* EventStore
      // Event without sessionId — should skip reduce
      yield* store.publish({ _tag: "SystemEvent" } as unknown as AgentEvent)
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(reduceCount.value).toBe(0)
  })
})
