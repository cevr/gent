import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { EventStore, SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type { LoadedExtension, ReduceResult } from "@gent/core/domain/extension"
import { fromReducer } from "@gent/core/runtime/extensions/from-reducer"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"
import { Storage } from "@gent/core/storage/sqlite-storage"

const sessionId = "persist-session" as SessionId
const branchId = "persist-branch" as BranchId

interface CounterState {
  readonly count: number
}

const CounterSchema = Schema.Struct({ count: Schema.Number })

const makeCounterExtension = (id = "persist-counter"): LoadedExtension => ({
  manifest: { id },
  kind: "builtin",
  sourcePath: "builtin",
  setup: {
    spawnActor: fromReducer<CounterState>({
      id,
      initial: { count: 0 },
      stateSchema: CounterSchema,
      persist: true,
      reduce: (state, event): ReduceResult<CounterState> => {
        if (event._tag === "TurnCompleted") {
          return {
            state: { count: state.count + 1 },
            effects: [{ _tag: "Persist" }],
          }
        }
        return { state }
      },
      derive: (state) => ({ uiModel: state }),
    }),
  },
})

const makeLayer = (extensions: LoadedExtension[]) =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live(extensions),
    EventStore.Memory,
    ExtensionTurnControl.Test(),
    ExtensionEventBus.Test(),
    Storage.Test(),
  )

describe("Extension state persistence", () => {
  test("Persist effect writes state to storage", async () => {
    const ext = makeCounterExtension()
    const layer = makeLayer([ext])

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const storage = yield* Storage

        // Trigger state change + Persist effect
        yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 100 }), {
          sessionId,
          branchId,
        })

        // Verify state was persisted
        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: "persist-counter",
        })
        expect(loaded).toBeDefined()
        const parsed = JSON.parse(loaded!.stateJson) as CounterState
        expect(parsed.count).toBe(1)
        expect(loaded!.version).toBe(1)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("state hydrated on actor init for resumed session", async () => {
    const layer = makeLayer([makeCounterExtension()])

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage

        // Pre-seed persisted state (simulating a previous session)
        yield* storage.saveExtensionState({
          sessionId,
          extensionId: "persist-counter",
          stateJson: JSON.stringify({ count: 42 }),
          version: 10,
        })

        // Now create the runtime — actor init should hydrate
        const runtime = yield* ExtensionStateRuntime

        // Trigger a no-op event to spawn the actor (lazy)
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })

        // Get snapshot — should have hydrated state
        const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
        const counter = snapshots.find((s) => s.extensionId === "persist-counter")
        expect(counter).toBeDefined()
        expect(counter!.epoch).toBe(10)
        expect((counter!.model as CounterState).count).toBe(42)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("Persist effect updates existing state", async () => {
    const layer = makeLayer([makeCounterExtension()])

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const storage = yield* Storage

        // Two turns → two Persist effects
        yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
          sessionId,
          branchId,
        })
        yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
          sessionId,
          branchId,
        })

        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: "persist-counter",
        })
        expect(loaded).toBeDefined()
        const parsed = JSON.parse(loaded!.stateJson) as CounterState
        expect(parsed.count).toBe(2)
        expect(loaded!.version).toBe(2)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("non-persistent actor does not write to storage", async () => {
    const nonPersistent: LoadedExtension = {
      manifest: { id: "ephemeral" },
      kind: "builtin",
      sourcePath: "builtin",
      setup: {
        spawnActor: fromReducer<{ value: number }>({
          id: "ephemeral",
          initial: { value: 0 },
          reduce: (state) => ({ state: { value: state.value + 1 } }),
        }),
      },
    }

    const layer = makeLayer([nonPersistent])

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const storage = yield* Storage

        yield* runtime.reduce(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
          sessionId,
          branchId,
        })

        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: "ephemeral",
        })
        expect(loaded).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("Extension state storage", () => {
  test("saveExtensionState + loadExtensionState round-trip", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage

        yield* storage.saveExtensionState({
          sessionId,
          extensionId: "test-ext",
          stateJson: JSON.stringify({ mode: "active" }),
          version: 5,
        })

        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: "test-ext",
        })
        expect(loaded).toBeDefined()
        expect(loaded!.stateJson).toBe(JSON.stringify({ mode: "active" }))
        expect(loaded!.version).toBe(5)
      }).pipe(Effect.provide(Storage.Test())),
    )
  })

  test("loadExtensionState returns undefined for missing state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: "nonexistent",
        })
        expect(loaded).toBeUndefined()
      }).pipe(Effect.provide(Storage.Test())),
    )
  })

  test("saveExtensionState upserts on conflict", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage

        yield* storage.saveExtensionState({
          sessionId,
          extensionId: "upsert-ext",
          stateJson: JSON.stringify({ v: 1 }),
          version: 1,
        })
        yield* storage.saveExtensionState({
          sessionId,
          extensionId: "upsert-ext",
          stateJson: JSON.stringify({ v: 2 }),
          version: 2,
        })

        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: "upsert-ext",
        })
        expect(loaded!.version).toBe(2)
        expect(JSON.parse(loaded!.stateJson)).toEqual({ v: 2 })
      }).pipe(Effect.provide(Storage.Test())),
    )
  })
})
