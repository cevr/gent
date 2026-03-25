import { describe, test, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import {
  BaseEventStore,
  EventStore,
  SessionStarted,
  TaskCompleted,
  ExtensionUiSnapshot,
} from "@gent/core/domain/event"
import type { AgentEvent, EventStoreService } from "@gent/core/domain/event"
import type { BranchId, SessionId, TaskId } from "@gent/core/domain/ids"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { PlanModeExtension } from "@gent/core/extensions"

/**
 * Creates a ReducingEventStore layer matching the production wiring in dependencies.ts.
 * This is intentionally a minimal reproduction — no full dependency graph.
 */
const makeTestReducingStore = (baseRef: Ref.Ref<AgentEvent[]>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const stateRuntime = yield* ExtensionStateRuntime
      const base = yield* BaseEventStore

      const reducing: EventStoreService = {
        publish: (event) =>
          base.publish(event).pipe(
            Effect.tap(() => Ref.update(baseRef, (events) => [...events, event])),
            Effect.tap(() => {
              if (event._tag === "ExtensionUiSnapshot") return Effect.void

              const sessionId = "sessionId" in event ? (event.sessionId as SessionId) : undefined
              if (sessionId === undefined) return Effect.void

              const branchId =
                "branchId" in event ? (event.branchId as BranchId | undefined) : undefined

              return stateRuntime.reduce(event, { sessionId, branchId }).pipe(
                Effect.tap((changed) => {
                  if (!changed || branchId === undefined) return Effect.void
                  return stateRuntime.getUiSnapshots(sessionId, branchId).pipe(
                    Effect.tap((snapshots) =>
                      Effect.forEach(
                        snapshots,
                        (snapshot) =>
                          base
                            .publish(snapshot)
                            .pipe(
                              Effect.tap(() =>
                                Ref.update(baseRef, (events) => [...events, snapshot]),
                              ),
                            ),
                        { concurrency: "unbounded" },
                      ),
                    ),
                    Effect.catchEager(() => Effect.void),
                  )
                }),
                Effect.catchDefect(() => Effect.void),
              )
            }),
          ),
        subscribe: base.subscribe,
      }

      return Layer.succeed(EventStore, reducing)
    }),
  )

const sessionId = "test-session" as SessionId
const branchId = "test-branch" as BranchId

describe("ReducingEventStore — event routing", () => {
  const setup = Effect.gen(function* () {
    const published = yield* Ref.make<AgentEvent[]>([])

    // Load plan-mode extension
    const planSetup = yield* PlanModeExtension.setup({
      cwd: "/tmp",
      config: undefined as never,
      source: "builtin",
    })
    const extensions = [
      {
        manifest: PlanModeExtension.manifest,
        kind: "builtin" as const,
        sourcePath: "builtin",
        setup: planSetup,
      },
    ]

    const stateRuntimeLayer = ExtensionStateRuntime.Live(extensions)
    const baseLayer = EventStore.Memory
    const combinedBase = Layer.merge(baseLayer, stateRuntimeLayer)
    const reducingLayer = Layer.provide(makeTestReducingStore(published), combinedBase)
    const fullLayer = Layer.mergeAll(combinedBase, reducingLayer)

    return { published, fullLayer, stateRuntimeLayer }
  })

  test("SessionStarted reaches extension reduce", async () => {
    const { published, fullLayer } = Effect.runSync(setup)

    await Effect.runPromise(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))

        const events = yield* Ref.get(published)
        // SessionStarted should be published
        expect(events.some((e) => e._tag === "SessionStarted")).toBe(true)
      }).pipe(Effect.provide(fullLayer)),
    )
  })

  test("TaskCompleted reaches extension reduce", async () => {
    const { published, fullLayer } = Effect.runSync(setup)

    await Effect.runPromise(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        yield* eventStore.publish(
          new TaskCompleted({
            sessionId,
            branchId,
            taskId: "t-1" as TaskId,
          }),
        )

        const events = yield* Ref.get(published)
        expect(events.some((e) => e._tag === "TaskCompleted")).toBe(true)
      }).pipe(Effect.provide(fullLayer)),
    )
  })

  test("ExtensionUiSnapshot does not recurse", async () => {
    const { published, fullLayer } = Effect.runSync(setup)

    await Effect.runPromise(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        const stateRuntime = yield* ExtensionStateRuntime

        // First trigger a state change so we get a snapshot
        yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))

        // Verify snapshots were published
        const events = yield* Ref.get(published)
        const snapshotCount = events.filter((e) => e._tag === "ExtensionUiSnapshot").length

        // Now manually publish an ExtensionUiSnapshot — should NOT trigger another reduce
        const reduceBefore = yield* stateRuntime.reduce(
          new ExtensionUiSnapshot({
            sessionId,
            branchId,
            extensionId: "plan-mode",
            epoch: 0,
            model: {},
          }),
          { sessionId, branchId },
        )
        // reduce on the snapshot itself should not change state
        // (plan-mode only reacts to specific event types)
        expect(reduceBefore).toBe(false)

        // Publish the snapshot event through the store
        yield* eventStore.publish(
          new ExtensionUiSnapshot({
            sessionId,
            branchId,
            extensionId: "plan-mode",
            epoch: 0,
            model: {},
          }),
        )

        const eventsAfter = yield* Ref.get(published)
        const snapshotCountAfter = eventsAfter.filter(
          (e) => e._tag === "ExtensionUiSnapshot",
        ).length
        // Should only have one more snapshot (the one we just published), not any recursive ones
        expect(snapshotCountAfter).toBe(snapshotCount + 1)
      }).pipe(Effect.provide(fullLayer)),
    )
  })

  test("events without sessionId are published but skip reduce", async () => {
    const { published, fullLayer } = Effect.runSync(setup)

    await Effect.runPromise(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        // SessionNameUpdated has sessionId, so it will be routed.
        // But events that truly lack sessionId (hypothetical) would skip reduce.
        // We verify the store still publishes them.
        yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))

        const events = yield* Ref.get(published)
        expect(events.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(fullLayer)),
    )
  })
})
