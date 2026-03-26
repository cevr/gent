import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Machine, State as MState, Event as MEvent } from "effect-machine"
import { SessionStarted, TurnCompleted, EventStore } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { fromMachine } from "@gent/core/runtime/extensions/from-machine"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { Storage } from "@gent/core/storage/sqlite-storage"
import type { LoadedExtension } from "@gent/core/domain/extension"

const sessionId = "machine-session" as SessionId
const branchId = "machine-branch" as BranchId

const testLayer = Layer.mergeAll(ExtensionTurnControl.Test(), ExtensionEventBus.Test())

// ── Test machine: simple counter with Idle/Counting states ──

const CounterState = MState({
  Idle: {},
  Counting: { count: Schema.Number },
})
type CounterState = typeof CounterState.Type

const CounterEvent = MEvent({
  Start: {},
  Increment: {},
  Reset: {},
})
type CounterEvent = typeof CounterEvent.Type

const counterMachine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: CounterState.Idle,
})
  .on(CounterState.Idle, CounterEvent.Start, () => CounterState.Counting({ count: 0 }))
  .on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
    CounterState.Counting({ count: state.count + 1 }),
  )
  .on(CounterState.Counting, CounterEvent.Reset, () => CounterState.Idle)
  .build()

describe("fromMachine", () => {
  test("handleEvent returns true on state change, false when unchanged", async () => {
    const { spawnActor: spawn } = fromMachine({
      id: "counter",
      built: counterMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return CounterEvent.Start
        if (event._tag === "TurnCompleted") return CounterEvent.Increment
        return undefined
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.init

        // SessionStarted → Start → Idle→Counting (changed)
        const changed1 = yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        expect(changed1).toBe(true)

        const { state } = yield* actor.getState
        expect((state as CounterState)._tag).toBe("Counting")

        // Unmapped event → no change
        const changed2 = yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        // Start when already Counting — no transition defined, state unchanged
        // Actually machine.on("Idle", "Start") — Start in Counting has no transition
        // Machine silently ignores unhandled events (state reference unchanged)
        expect(changed2).toBe(false)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("handleIntent dispatches intent as machine event", async () => {
    const IntentSchema = Schema.Struct({ action: Schema.Literals(["start", "increment"]) })
    type Intent = typeof IntentSchema.Type

    const { spawnActor: spawn } = fromMachine<CounterState, CounterEvent, Intent>({
      id: "intent-counter",
      built: counterMachine,
      mapIntent: (intent) => {
        if (intent.action === "start") return CounterEvent.Start
        return CounterEvent.Increment
      },
      intentSchema: IntentSchema,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.init

        expect(actor.handleIntent).toBeDefined()

        // Start → Idle→Counting
        const changed1 = yield* actor.handleIntent!({ action: "start" })
        expect(changed1).toBe(true)

        const { state: s1 } = yield* actor.getState
        expect((s1 as CounterState)._tag).toBe("Counting")

        // Increment → Counting.count 0→1
        const changed2 = yield* actor.handleIntent!({ action: "increment" })
        expect(changed2).toBe(true)

        const { state: s2 } = yield* actor.getState
        const counting = s2 as Extract<CounterState, { _tag: "Counting" }>
        expect(counting.count).toBe(1)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("version tracking is atomic via Ref", async () => {
    const { spawnActor: spawn } = fromMachine({
      id: "versioned",
      built: counterMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return CounterEvent.Start
        if (event._tag === "TurnCompleted") return CounterEvent.Increment
        return undefined
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.init

        const { version: v0 } = yield* actor.getState
        expect(v0).toBe(0)

        // Start → version 1
        yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        const { version: v1 } = yield* actor.getState
        expect(v1).toBe(1)

        // Increment → version 2
        yield* actor.handleEvent(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
          sessionId,
          branchId,
        })
        const { version: v2 } = yield* actor.getState
        expect(v2).toBe(2)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("getState returns current state and version", async () => {
    const { spawnActor: spawn } = fromMachine({
      id: "state-getter",
      built: counterMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return { _tag: "Start" as const }
        return undefined
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.init

        const initial = yield* actor.getState
        expect((initial.state as CounterState)._tag).toBe("Idle")
        expect(initial.version).toBe(0)

        yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const after = yield* actor.getState
        expect((after.state as CounterState)._tag).toBe("Counting")
        expect(after.version).toBe(1)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("terminate stops the machine actor", async () => {
    const { spawnActor: spawn } = fromMachine({
      id: "terminable",
      built: counterMachine,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.init
        yield* actor.terminate
        // After terminate, getState should still return last known state
        const { state } = yield* actor.getState
        expect((state as CounterState)._tag).toBe("Idle")
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("projection registered separately from actor", () => {
    const { projection } = fromMachine({
      id: "projector",
      built: counterMachine,
      derive: (state) => ({
        uiModel: { tag: state._tag },
      }),
    })

    expect(projection).toBeDefined()
    const ui = projection!.deriveUi!({ _tag: "Counting", count: 5 })
    expect(ui).toEqual({ tag: "Counting" })
  })

  test("deriveUi fallback uses safe sentinel when derive reads ctx.agent", () => {
    const { projection } = fromMachine({
      id: "sentinel-test",
      built: counterMachine,
      derive: (state, ctx) => ({
        uiModel: { tag: state._tag, agentName: ctx.agent.name },
      }),
    })

    expect(projection).toBeDefined()
    const ui = projection!.deriveUi!({ _tag: "Idle" }) as { tag: string; agentName: string }
    expect(ui.tag).toBe("Idle")
    expect(ui.agentName).toBe("__derive_ui__")
  })

  test("no projection when derive not provided", () => {
    const { projection } = fromMachine({
      id: "no-derive",
      built: counterMachine,
    })

    expect(projection).toBeUndefined()
  })

  test("persistence: state hydrated on init", async () => {
    const CounterStateSchema = CounterState

    const { spawnActor, projection } = fromMachine({
      id: "persist-counter",
      built: counterMachine,
      stateSchema: CounterStateSchema,
      persist: true,
      derive: (state) => ({ uiModel: { tag: state._tag } }),
    })

    const ext: LoadedExtension = {
      manifest: { id: "persist-counter" },
      kind: "builtin",
      sourcePath: "builtin",
      setup: { spawnActor, projection },
    }

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live([ext]),
      EventStore.Memory,
      ExtensionTurnControl.Test(),
      ExtensionEventBus.Test(),
      Storage.Test(),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage

        // Pre-seed persisted state
        yield* storage.saveExtensionState({
          sessionId,
          extensionId: "persist-counter",
          stateJson: JSON.stringify({ _tag: "Counting", count: 42 }),
          version: 7,
        })

        const runtime = yield* ExtensionStateRuntime
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
        const counter = snapshots.find((s) => s.extensionId === "persist-counter")
        expect(counter).toBeDefined()
        expect(counter!.epoch).toBe(7)
        expect(counter!.model).toEqual({ tag: "Counting" })
      }).pipe(Effect.provide(layer)),
    )
  })
})
