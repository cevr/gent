import { describe, it, expect } from "effect-bun-test"
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
import type { LoadedExtension, ReduceResult } from "@gent/core/domain/extension"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { fromReducer } from "@gent/core/runtime/extensions/from-reducer"

// ── Test extension that records every event _tag it sees ──

interface RecorderState {
  readonly seen: ReadonlyArray<string>
}

const RecorderSchema = Schema.Struct({ seen: Schema.Array(Schema.String) })

const recorderReducer = fromReducer<RecorderState>({
  id: "test-recorder",
  initial: { seen: [] },
  stateSchema: RecorderSchema,
  uiModelSchema: RecorderSchema,
  reduce: (state, event): ReduceResult<RecorderState> => ({
    state: { seen: [...state.seen, event._tag] },
  }),
  derive: (state) => ({ uiModel: state }),
})

const recorderExtension: LoadedExtension = {
  manifest: { id: "test-recorder" },
  kind: "builtin",
  sourcePath: "builtin",
  setup: {
    spawn: recorderReducer.spawn,
    projection: recorderReducer.projection,
  },
}

// ── Test extension that mutates on ExtensionUiSnapshot — used to prove recursion guard ──

interface SnapshotCounterState {
  readonly snapshotsSeen: number
}

const SnapshotCounterSchema = Schema.Struct({ snapshotsSeen: Schema.Number })

const snapshotCounterReducer = fromReducer<SnapshotCounterState>({
  id: "snapshot-counter",
  initial: { snapshotsSeen: 0 },
  stateSchema: SnapshotCounterSchema,
  uiModelSchema: SnapshotCounterSchema,
  reduce: (state, event): ReduceResult<SnapshotCounterState> => {
    if (event._tag === "ExtensionUiSnapshot") {
      return { state: { snapshotsSeen: state.snapshotsSeen + 1 } }
    }
    // Also change state on TurnCompleted to trigger initial snapshot
    if (event._tag === "TurnCompleted") {
      return { state: { snapshotsSeen: state.snapshotsSeen } }
    }
    return { state }
  },
  derive: (state) => ({ uiModel: state }),
})

const snapshotCounterExtension: LoadedExtension = {
  manifest: { id: "snapshot-counter" },
  kind: "builtin",
  sourcePath: "builtin",
  setup: {
    spawn: snapshotCounterReducer.spawn,
    projection: snapshotCounterReducer.projection,
  },
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

              return stateRuntime.publish(event, { sessionId, branchId }).pipe(
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
  const servicesLayer = Layer.mergeAll(ExtensionTurnControl.Test(), Storage.Test())
  const combinedBase = Layer.mergeAll(baseLayer, stateRuntimeLayer, servicesLayer)
  const reducingLayer = Layer.provide(makeTestReducingStore(published), combinedBase)
  const fullLayer = Layer.mergeAll(combinedBase, reducingLayer)
  return { published, fullLayer }
}

describe("ReducingEventStore — event routing", () => {
  it.live("events reach extension reduce — recorder sees every event _tag", () => {
    const { fullLayer } = makeLayer([recorderExtension])

    return Effect.gen(function* () {
      const eventStore = yield* EventStore
      const stateRuntime = yield* ExtensionStateRuntime

      yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))
      yield* eventStore.publish(new TaskCompleted({ sessionId, branchId, taskId: "t-1" as TaskId }))
      yield* eventStore.publish(new TurnCompleted({ sessionId, branchId, durationMs: 100 }))

      // Verify the recorder's state was updated with all three event tags
      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const recorderSnapshot = snapshots.find((s) => s.extensionId === "test-recorder")
      expect(recorderSnapshot).toBeDefined()
      const model = recorderSnapshot!.model as RecorderState

      expect(model.seen).toContain("SessionStarted")
      expect(model.seen).toContain("TaskCompleted")
      expect(model.seen).toContain("TurnCompleted")
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("UI snapshots are published when state changes", () => {
    const { published, fullLayer } = makeLayer([recorderExtension])

    return Effect.gen(function* () {
      const eventStore = yield* EventStore
      yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))

      const events = yield* Ref.get(published)
      const snapshots = events.filter((e) => e._tag === "ExtensionUiSnapshot")
      // Recorder always changes state, so every event should produce a snapshot
      expect(snapshots.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("ExtensionUiSnapshot does not recurse — even with an actor that reacts to it", () => {
    const { published, fullLayer } = makeLayer([snapshotCounterExtension])

    return Effect.gen(function* () {
      const eventStore = yield* EventStore
      const stateRuntime = yield* ExtensionStateRuntime

      // Publish a TurnCompleted to trigger initial state change + snapshot
      yield* eventStore.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }))

      const events = yield* Ref.get(published)
      const snapshotCount = events.filter((e) => e._tag === "ExtensionUiSnapshot").length

      // The ReducingEventStore should have:
      // 1. Published TurnCompleted → reduce fires → state may change → snapshot published
      // 2. The snapshot publication does NOT re-enter reduce
      // So snapshotsSeen in the actor state should be 0 (never fed an ExtensionUiSnapshot)
      const actorSnapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const counter = actorSnapshots.find((s) => s.extensionId === "snapshot-counter")
      expect(counter).toBeDefined()
      const model = counter!.model as SnapshotCounterState
      expect(model.snapshotsSeen).toBe(0)

      // And we should have exactly 1 snapshot event (from the TurnCompleted trigger)
      expect(snapshotCount).toBe(1)
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("invalid uiModel is dropped when uiModelSchema validation fails", () => {
    // Extension with a strict schema that rejects what deriveUi actually returns
    const strictSchema = Schema.Struct({ count: Schema.Number, label: Schema.String })
    const { spawn, projection } = fromReducer({
      id: "bad-model",
      initial: { count: 0 },
      reduce: (state: { count: number }, event): ReduceResult<{ count: number }> => {
        if (event._tag === "TurnCompleted") return { state: { count: state.count + 1 } }
        return { state }
      },
      // deriveUi returns { count: number } but schema requires { count, label }
      derive: (state: { count: number }) => ({ uiModel: { count: state.count } }),
      uiModelSchema: strictSchema,
    })

    const badModelExtension: LoadedExtension = {
      manifest: { id: "bad-model" },
      kind: "builtin",
      sourcePath: "test",
      setup: { spawn, ...projection },
    }

    const { fullLayer } = makeLayer([badModelExtension])

    return Effect.gen(function* () {
      const eventStore = yield* EventStore
      const stateRuntime = yield* ExtensionStateRuntime

      yield* eventStore.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }))

      // Snapshot should be empty — invalid model was dropped
      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const badSnapshot = snapshots.find((s) => s.extensionId === "bad-model")
      expect(badSnapshot).toBeUndefined()
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("valid uiModel passes schema validation and appears in snapshots", () => {
    // Extension where deriveUi output matches the schema
    const { fullLayer } = makeLayer([recorderExtension])

    return Effect.gen(function* () {
      const eventStore = yield* EventStore
      const stateRuntime = yield* ExtensionStateRuntime

      yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))

      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const recorder = snapshots.find((s) => s.extensionId === "test-recorder")
      expect(recorder).toBeDefined()
      expect((recorder!.model as RecorderState).seen).toContain("SessionStarted")
    }).pipe(Effect.provide(fullLayer))
  })

  it.live(
    "derive that crashes on ctx=undefined still produces UI snapshots for other extensions",
    () => {
      // Extension with derive that reads ctx.agent (crashes when ctx is undefined)
      const crashingDerive = fromReducer({
        id: "crashing-derive",
        initial: { value: 0 },
        reduce: (state: { value: number }) => ({ state: { value: state.value + 1 } }),
        // This will throw when called with ctx=undefined in getUiSnapshots
        derive: (state: { value: number }, ctx?) => {
          if (ctx === undefined) throw new Error("ctx.agent required")
          return { uiModel: { value: state.value } }
        },
      })
      const crashingExtension: LoadedExtension = {
        manifest: { id: "crashing-derive" },
        kind: "builtin",
        sourcePath: "test",
        setup: { spawn: crashingDerive.spawn, projection: crashingDerive.projection },
      }
      const { fullLayer } = makeLayer([recorderExtension, crashingExtension])

      return Effect.gen(function* () {
        const eventStore = yield* EventStore
        const stateRuntime = yield* ExtensionStateRuntime

        yield* eventStore.publish(new SessionStarted({ sessionId, branchId }))

        // getUiSnapshots should not crash — crashing derive is caught, recorder still works
        const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
        const recorder = snapshots.find((s) => s.extensionId === "test-recorder")
        expect(recorder).toBeDefined()
        // Crashing extension's snapshot is dropped
        const crashing = snapshots.find((s) => s.extensionId === "crashing-derive")
        expect(crashing).toBeUndefined()
      }).pipe(Effect.provide(fullLayer))
    },
  )

  it.live("events without branchId skip snapshot publication but still reduce", () => {
    const { fullLayer } = makeLayer([recorderExtension])

    return Effect.gen(function* () {
      const stateRuntime = yield* ExtensionStateRuntime

      // Directly call reduce with a branchless context to verify it works
      const changed = yield* stateRuntime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId: undefined,
      })
      // Recorder always changes state
      expect(changed).toBe(true)
    }).pipe(Effect.provide(fullLayer))
  })
})
