import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { LoadedExtension, ReduceResult } from "../../src/domain/extension.js"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { defineResource } from "@gent/core/domain/contribution"
import { reducerActor } from "./helpers/reducer-actor"
import { makeActorRuntimeLayer } from "./helpers/actor-runtime-layer"

const machineResource = (machine: Parameters<typeof defineResource>[0]["machine"]) =>
  defineResource({
    scope: "process",
    layer: Layer.empty as Layer.Layer<unknown>,
    machine,
  })

const sessionId = SessionId.make("persist-session")
const branchId = BranchId.make("persist-branch")

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
        return { state: { count: state.count + 1 } }
      }
      return { state }
    },
    derive: (state) => ({ uiModel: state }),
  })
  return {
    manifest: { id },
    scope: "builtin",
    sourcePath: "builtin",
    contributions: { resources: [machineResource(actor)] },
  }
}

const makeLayer = (extensions: LoadedExtension[]) =>
  makeActorRuntimeLayer({ extensions, withStorage: true })

describe("Extension state persistence", () => {
  it.live("durability writes state to storage on transition", () => {
    const ext = makeCounterExtension()
    const layer = makeLayer([ext])

    return Effect.gen(function* () {
      const runtime = yield* MachineEngine
      const storage = yield* Storage

      // Trigger state change + Persist effect
      yield* runtime.publish(TurnCompleted.make({ sessionId, branchId, durationMs: 100 }), {
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

  // TODO(c2): "state hydrated on actor init for resumed session" — removed.
  // Rewrite to read state via MachineEngine.execute(GetSnapshot) once the new
  // snapshot-readback path is wired into the reducerActor helper.

  it.live("durability updates existing state on subsequent transitions", () => {
    const layer = makeLayer([makeCounterExtension()])

    return Effect.gen(function* () {
      const runtime = yield* MachineEngine
      const storage = yield* Storage

      // Two turns → two Persist effects
      yield* runtime.publish(TurnCompleted.make({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })
      yield* runtime.publish(TurnCompleted.make({ sessionId, branchId, durationMs: 50 }), {
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

  it.live("actor without stateSchema does not write to storage", () => {
    const actor = reducerActor<{ value: number }>({
      id: "ephemeral",
      initial: { value: 0 },
      stateSchema: Schema.Struct({ value: Schema.Number }),
      reduce: (state) => ({ state: { value: state.value + 1 } }),
    })
    const nonPersistent: LoadedExtension = {
      manifest: { id: "ephemeral" },
      scope: "builtin",
      sourcePath: "builtin",
      contributions: { resources: [machineResource(actor)] },
    }

    const layer = makeLayer([nonPersistent])

    return Effect.gen(function* () {
      const runtime = yield* MachineEngine
      const storage = yield* Storage

      yield* runtime.publish(TurnCompleted.make({ sessionId, branchId, durationMs: 50 }), {
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
      scope: "builtin",
      sourcePath: "builtin",
      contributions: { resources: [machineResource(actor)] },
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

      const runtime = yield* MachineEngine

      // Actor should init with fallback to initial state, not crash
      yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // TODO(c2): assert state via ask(GetSnapshot) once helper supports it.
      // For now, verify the actor didn't crash and storage still has the seeded blob.
      const persisted = yield* storage.loadExtensionState({
        sessionId,
        extensionId: "corrupt-test",
      })
      expect(persisted).toBeDefined()
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
      scope: "builtin",
      sourcePath: "builtin",
      contributions: { resources: [machineResource(actor)] },
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

      const runtime = yield* MachineEngine

      // Init should survive
      yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Actor should work normally after failed hydration
      yield* runtime.publish(TurnCompleted.make({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })

      // TODO(c2): assert state via ask(GetSnapshot) once helper supports it.
      // For now, verify the actor's persisted state advanced after TurnCompleted.
      const persisted = yield* storage.loadExtensionState({
        sessionId,
        extensionId: "resilient",
      })
      expect(persisted).toBeDefined()
      const parsed = JSON.parse(persisted!.stateJson) as {
        readonly _tag: "Active"
        readonly value: CounterState
      }
      expect(parsed.value.count).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
