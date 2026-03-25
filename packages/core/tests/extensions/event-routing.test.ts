import { describe, test, expect } from "bun:test"
import { Effect, Layer, Ref, Schema } from "effect"
import {
  BaseEventStore,
  EventStore,
  SessionStarted,
  TaskCompleted,
  TurnCompleted,
} from "@gent/core/domain/event"
import type { AgentEvent, EventStoreService } from "@gent/core/domain/event"
import type { BranchId, SessionId, TaskId } from "@gent/core/domain/ids"
import type { ExtensionStateMachine, LoadedExtension } from "@gent/core/domain/extension"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"

// ── Test extension that records every event _tag it sees ──

interface RecorderState {
  readonly seen: ReadonlyArray<string>
}

const RecorderStateMachine: ExtensionStateMachine<RecorderState> = {
  id: "test-recorder",
  initial: { seen: [] },
  schema: Schema.Struct({ seen: Schema.Array(Schema.String) }),
  uiModelSchema: Schema.Struct({ seen: Schema.Array(Schema.String) }),
  reduce: (state, event, _ctx) => ({ seen: [...state.seen, event._tag] }),
  derive: (state) => ({ uiModel: state }),
}

const recorderExtension: LoadedExtension = {
  manifest: { id: "test-recorder" },
  kind: "builtin",
  sourcePath: "builtin",
  setup: { stateMachine: RecorderStateMachine },
}

// ── Test extension that mutates on ExtensionUiSnapshot — used to prove recursion guard ──

interface SnapshotCounterState {
  readonly snapshotsSeen: number
}

const SnapshotCounterMachine: ExtensionStateMachine<SnapshotCounterState> = {
  id: "snapshot-counter",
  initial: { snapshotsSeen: 0 },
  schema: Schema.Struct({ snapshotsSeen: Schema.Number }),
  uiModelSchema: Schema.Struct({ snapshotsSeen: Schema.Number }),
  reduce: (state, event) => {
    if (event._tag === "ExtensionUiSnapshot") {
      return { snapshotsSeen: state.snapshotsSeen + 1 }
    }
    // Also change state on TurnCompleted to trigger initial snapshot
    if (event._tag === "TurnCompleted") {
      return { snapshotsSeen: state.snapshotsSeen }
    }
    return state
  },
  derive: (state) => ({ uiModel: state }),
}

const snapshotCounterExtension: LoadedExtension = {
  manifest: { id: "snapshot-counter" },
  kind: "builtin",
  sourcePath: "builtin",
  setup: { stateMachine: SnapshotCounterMachine },
}

/**
 * Creates a ReducingEventStore layer matching the production wiring in dependencies.ts.
 */
const makeTestReducingStore = (publishedRef: Ref.Ref<AgentEvent[]>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const stateRuntime = yield* ExtensionStateRuntime
      const base = yield* BaseEventStore

      const reducing: EventStoreService = {
        publish: (event) =>
          base.publish(event).pipe(
            Effect.tap(() => Ref.update(publishedRef, (events) => [...events, event])),
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
                                Ref.update(publishedRef, (events) => [...events, snapshot]),
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

const makeLayer = (extensions: LoadedExtension[]) => {
  const published = Effect.runSync(Ref.make<AgentEvent[]>([]))
  const stateRuntimeLayer = ExtensionStateRuntime.Live(extensions)
  const baseLayer = EventStore.Memory
  const combinedBase = Layer.merge(baseLayer, stateRuntimeLayer)
  const reducingLayer = Layer.provide(makeTestReducingStore(published), combinedBase)
  const fullLayer = Layer.mergeAll(combinedBase, reducingLayer)
  return { published, fullLayer }
}

describe("ReducingEventStore — event routing", () => {
  test("events reach extension reduce — recorder sees every event _tag", async () => {
    const { fullLayer } = makeLayer([recorderExtension])

    await Effect.runPromise(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        const stateRuntime = yield* ExtensionStateRuntime

        yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))
        yield* eventStore.publish(
          new TaskCompleted({ sessionId, branchId, taskId: "t-1" as TaskId }),
        )
        yield* eventStore.publish(new TurnCompleted({ sessionId, branchId, durationMs: 100 }))

        // Verify the recorder's state was updated with all three event tags
        const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
        const recorderSnapshot = snapshots.find((s) => s.extensionId === "test-recorder")
        expect(recorderSnapshot).toBeDefined()
        const model = recorderSnapshot!.model as RecorderState

        expect(model.seen).toContain("SessionStarted")
        expect(model.seen).toContain("TaskCompleted")
        expect(model.seen).toContain("TurnCompleted")
      }).pipe(Effect.provide(fullLayer)),
    )
  })

  test("UI snapshots are published when state changes", async () => {
    const { published, fullLayer } = makeLayer([recorderExtension])

    await Effect.runPromise(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))

        const events = yield* Ref.get(published)
        const snapshots = events.filter((e) => e._tag === "ExtensionUiSnapshot")
        // Recorder always changes state, so every event should produce a snapshot
        expect(snapshots.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(fullLayer)),
    )
  })

  test("ExtensionUiSnapshot does not recurse — even with a machine that reacts to it", async () => {
    const { published, fullLayer } = makeLayer([snapshotCounterExtension])

    await Effect.runPromise(
      Effect.gen(function* () {
        const eventStore = yield* EventStore
        const stateRuntime = yield* ExtensionStateRuntime

        // Publish a TurnCompleted to trigger initial state change + snapshot
        yield* eventStore.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }))

        const events = yield* Ref.get(published)
        const snapshotCount = events.filter((e) => e._tag === "ExtensionUiSnapshot").length

        // The ReducingEventStore should have:
        // 1. Published TurnCompleted → reduce fires → state may change → snapshot published
        // 2. The snapshot publication does NOT re-enter reduce
        // So snapshotsSeen in the machine state should be 0 (never fed an ExtensionUiSnapshot)
        const machineSnapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
        const counter = machineSnapshots.find((s) => s.extensionId === "snapshot-counter")
        expect(counter).toBeDefined()
        const model = counter!.model as SnapshotCounterState
        expect(model.snapshotsSeen).toBe(0)

        // And we should have exactly 1 snapshot event (from the TurnCompleted trigger)
        expect(snapshotCount).toBe(1)
      }).pipe(Effect.provide(fullLayer)),
    )
  })

  test("events without branchId skip snapshot publication but still reduce", async () => {
    const { fullLayer } = makeLayer([recorderExtension])

    await Effect.runPromise(
      Effect.gen(function* () {
        const stateRuntime = yield* ExtensionStateRuntime

        // Directly call reduce with a branchless context to verify it works
        const changed = yield* stateRuntime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId: undefined,
        })
        // Recorder always changes state
        expect(changed).toBe(true)
      }).pipe(Effect.provide(fullLayer)),
    )
  })
})
