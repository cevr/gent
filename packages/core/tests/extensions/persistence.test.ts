import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { EventStore, SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type { LoadedExtension, ReduceResult } from "@gent/core/domain/extension"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { reducerActor } from "./helpers/reducer-actor"

const sessionId = "persist-session" as SessionId
const branchId = "persist-branch" as BranchId

interface CounterState {
  readonly count: number
}

const CounterSchema = Schema.Struct({ count: Schema.Number })

const makeCounterExtension = (id = "persist-counter"): LoadedExtension => {
  const actor = reducerActor<CounterState>({
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
  })
  return { manifest: { id }, kind: "builtin", sourcePath: "builtin", setup: { actor } }
}

const makeLayer = (extensions: LoadedExtension[]) =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(ExtensionTurnControl.Test())),
    EventStore.Memory,
    Storage.Test(),
  )

describe("Extension state persistence", () => {
  it.live("Persist effect writes state to storage", () => {
    const ext = makeCounterExtension()
    const layer = makeLayer([ext])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const storage = yield* Storage

      // Trigger state change + Persist effect
      yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 100 }), {
        sessionId,
        branchId,
      })

      // Verify state was persisted
      const loaded = yield* storage.loadExtensionState({
        sessionId,
        extensionId: "persist-counter",
      })
      expect(loaded).toBeDefined()
      const parsed = JSON.parse(loaded!.stateJson) as {
        readonly _tag: "Active"
        readonly value: CounterState
      }
      expect(parsed.value.count).toBe(1)
      expect(loaded!.version).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.live("state hydrated on actor init for resumed session", () => {
    const layer = makeLayer([makeCounterExtension()])

    return Effect.gen(function* () {
      const storage = yield* Storage

      // Pre-seed persisted state (simulating a previous session)
      yield* storage.saveExtensionState({
        sessionId,
        extensionId: "persist-counter",
        stateJson: JSON.stringify({ _tag: "Active", value: { count: 42 } }),
        version: 10,
      })

      // Now create the runtime — actor init should hydrate
      const runtime = yield* ExtensionStateRuntime

      // Trigger a no-op event to spawn the actor (lazy)
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })

      // Get snapshot — should have hydrated state
      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const counter = snapshots.find((s) => s.extensionId === "persist-counter")
      expect(counter).toBeDefined()
      expect(counter!.epoch).toBe(10)
      expect((counter!.model as CounterState).count).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  it.live("Persist effect updates existing state", () => {
    const layer = makeLayer([makeCounterExtension()])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const storage = yield* Storage

      // Two turns → two Persist effects
      yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })
      yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })

      const loaded = yield* storage.loadExtensionState({
        sessionId,
        extensionId: "persist-counter",
      })
      expect(loaded).toBeDefined()
      const parsed = JSON.parse(loaded!.stateJson) as {
        readonly _tag: "Active"
        readonly value: CounterState
      }
      expect(parsed.value.count).toBe(2)
      expect(loaded!.version).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "persist: true auto-persists on every state change without explicit Persist effect",
    () => {
      // Auto-persist extension: no Persist effect emitted, but persist: true
      const actor = reducerActor<CounterState>({
        id: "auto-persist",
        initial: { count: 0 },
        stateSchema: CounterSchema,
        persist: true,
        reduce: (state, event): ReduceResult<CounterState> => {
          if (event._tag === "TurnCompleted") {
            // No Persist effect — auto-persist should handle it
            return { state: { count: state.count + 1 } }
          }
          return { state }
        },
      })
      const autoPersistExt: LoadedExtension = {
        manifest: { id: "auto-persist" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor },
      }

      const layer = makeLayer([autoPersistExt])

      return Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const storage = yield* Storage

        yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
          sessionId,
          branchId,
        })

        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: "auto-persist",
        })
        expect(loaded).toBeDefined()
        const parsed = JSON.parse(loaded!.stateJson) as {
          readonly _tag: "Active"
          readonly value: CounterState
        }
        expect(parsed.value.count).toBe(1)
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("non-persistent actor does not write to storage", () => {
    const actor = reducerActor<{ value: number }>({
      id: "ephemeral",
      initial: { value: 0 },
      stateSchema: Schema.Struct({ value: Schema.Number }),
      reduce: (state) => ({ state: { value: state.value + 1 } }),
    })
    const nonPersistent: LoadedExtension = {
      manifest: { id: "ephemeral" },
      kind: "builtin",
      sourcePath: "builtin",
      setup: { actor },
    }

    const layer = makeLayer([nonPersistent])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const storage = yield* Storage

      yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })

      const loaded = yield* storage.loadExtensionState({
        sessionId,
        extensionId: "ephemeral",
      })
      expect(loaded).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })
})

describe("Extension state storage", () => {
  it.live("saveExtensionState + loadExtensionState round-trip", () =>
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

  it.live("loadExtensionState returns undefined for missing state", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const loaded = yield* storage.loadExtensionState({
        sessionId,
        extensionId: "nonexistent",
      })
      expect(loaded).toBeUndefined()
    }).pipe(Effect.provide(Storage.Test())),
  )

  it.live("saveExtensionState upserts on conflict", () =>
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

describe("Persistence edge cases", () => {
  it.live("corrupted persisted state falls back to initial", () => {
    const actor = reducerActor<CounterState>({
      id: "corrupt-test",
      initial: { count: 0 },
      stateSchema: CounterSchema,
      persist: true,
      reduce: (state, event): ReduceResult<CounterState> => {
        if (event._tag === "TurnCompleted") return { state: { count: state.count + 1 } }
        return { state }
      },
      derive: (state) => ({ uiModel: state }),
    })

    const ext: LoadedExtension = {
      manifest: { id: "corrupt-test" },
      kind: "builtin",
      sourcePath: "builtin",
      setup: { actor },
    }

    const layer = makeLayer([ext])

    return Effect.gen(function* () {
      const storage = yield* Storage

      // Seed with invalid JSON
      yield* storage.saveExtensionState({
        sessionId,
        extensionId: "corrupt-test",
        stateJson: "not valid json {{{",
        version: 5,
      })

      const runtime = yield* ExtensionStateRuntime

      // Actor should init with fallback to initial state, not crash
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const snap = snapshots.find((s) => s.extensionId === "corrupt-test")
      expect(snap).toBeDefined()
      // Should have initial state (count: 0), not the corrupt version
      expect((snap!.model as CounterState).count).toBe(0)
      // Epoch should be 0 since hydration failed
      expect(snap!.epoch).toBe(0)
    }).pipe(Effect.provide(layer))
  })

  it.live("hydration failure does not prevent actor from functioning", () => {
    const actor = reducerActor<CounterState>({
      id: "resilient",
      initial: { count: 0 },
      stateSchema: CounterSchema,
      persist: true,
      reduce: (state, event): ReduceResult<CounterState> => {
        if (event._tag === "TurnCompleted") return { state: { count: state.count + 1 } }
        return { state }
      },
      derive: (state) => ({ uiModel: state }),
    })

    const ext: LoadedExtension = {
      manifest: { id: "resilient" },
      kind: "builtin",
      sourcePath: "builtin",
      setup: { actor },
    }

    const layer = makeLayer([ext])

    return Effect.gen(function* () {
      const storage = yield* Storage

      // Seed with schema-invalid JSON (wrong shape)
      yield* storage.saveExtensionState({
        sessionId,
        extensionId: "resilient",
        stateJson: JSON.stringify({ wrong: "shape" }),
        version: 3,
      })

      const runtime = yield* ExtensionStateRuntime

      // Init should survive
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Actor should work normally after failed hydration
      yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })

      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const snap = snapshots.find((s) => s.extensionId === "resilient")
      expect(snap).toBeDefined()
      expect((snap!.model as CounterState).count).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
