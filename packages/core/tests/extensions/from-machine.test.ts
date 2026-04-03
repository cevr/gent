import { describe, it, test, expect } from "effect-bun-test"
import { Cause, Effect, Layer, Logger, Schema } from "effect"
import { CurrentLogAnnotations } from "effect/References"
import { Machine, State as MState, Event as MEvent } from "effect-machine"
import { SessionStarted, TurnCompleted, EventStore } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { fromMachine } from "@gent/core/runtime/extensions/from-machine"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { Storage } from "@gent/core/storage/sqlite-storage"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { ExtensionMessage, ExtensionProtocolError } from "@gent/core/domain/extension-protocol"

const sessionId = "machine-session" as SessionId
const branchId = "machine-branch" as BranchId

const testLayer = ExtensionTurnControl.Test()

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

describe("fromMachine", () => {
  it.live("handleEvent returns true on state change, false when unchanged", () => {
    const { spawn } = fromMachine({
      id: "counter",
      built: counterMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return CounterEvent.Start
        if (event._tag === "TurnCompleted") return CounterEvent.Increment
        return undefined
      },
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start

      // SessionStarted → Start → Idle→Counting (changed)
      const changed1 = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed1).toBe(true)

      const { state } = yield* actor.snapshot
      expect((state as CounterState)._tag).toBe("Counting")

      // Unmapped event → no change
      const changed2 = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      // Start when already Counting — no transition defined, state unchanged
      // Actually machine.on("Idle", "Start") — Start in Counting has no transition
      // Machine silently ignores unhandled events (state reference unchanged)
      expect(changed2).toBe(false)
    }).pipe(Effect.provide(testLayer))
  })

  it.live("send dispatches protocol message as machine event", () => {
    const IntentSchema = Schema.Struct({ action: Schema.Literals(["start", "increment"]) })
    type Intent = typeof IntentSchema.Type

    const { spawn } = fromMachine<CounterState, CounterEvent, Intent>({
      id: "intent-counter",
      built: counterMachine,
      mapMessage: (intent) => {
        if (intent.action === "start") return CounterEvent.Start
        return CounterEvent.Increment
      },
      messageSchema: IntentSchema,
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start

      yield* actor.send({ extensionId: "intent-counter", _tag: "Message", action: "start" })

      const { state: s1 } = yield* actor.snapshot
      expect((s1 as CounterState)._tag).toBe("Counting")

      // Increment → Counting.count 0→1
      yield* actor.send({ extensionId: "intent-counter", _tag: "Message", action: "increment" })

      const { state: s2 } = yield* actor.snapshot
      const counting = s2 as Extract<CounterState, { _tag: "Counting" }>
      expect(counting.count).toBe(1)
    }).pipe(Effect.provide(testLayer))
  })

  it.live("epoch tracking is atomic via Ref", () => {
    const { spawn } = fromMachine({
      id: "versioned",
      built: counterMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return CounterEvent.Start
        if (event._tag === "TurnCompleted") return CounterEvent.Increment
        return undefined
      },
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start

      const { epoch: v0 } = yield* actor.snapshot
      expect(v0).toBe(0)

      // Start → epoch 1
      yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      const { epoch: v1 } = yield* actor.snapshot
      expect(v1).toBe(1)

      // Increment → epoch 2
      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })
      const { epoch: v2 } = yield* actor.snapshot
      expect(v2).toBe(2)
    }).pipe(Effect.provide(testLayer))
  })

  it.live("snapshot returns current state and epoch", () => {
    const { spawn } = fromMachine({
      id: "state-getter",
      built: counterMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return { _tag: "Start" as const }
        return undefined
      },
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start

      const initial = yield* actor.snapshot
      expect((initial.state as CounterState)._tag).toBe("Idle")
      expect(initial.epoch).toBe(0)

      yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      const after = yield* actor.snapshot
      expect((after.state as CounterState)._tag).toBe("Counting")
      expect(after.epoch).toBe(1)
    }).pipe(Effect.provide(testLayer))
  })

  it.live("terminate stops the machine actor", () => {
    const { spawn } = fromMachine({
      id: "terminable",
      built: counterMachine,
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start
      yield* actor.stop
      // After terminate, getState should still return last known state
      const { state } = yield* actor.snapshot
      expect((state as CounterState)._tag).toBe("Idle")
    }).pipe(Effect.provide(testLayer))
  })

  it.live("unsupported requests fail loudly instead of no-oping", () => {
    const GetStatus = ExtensionMessage.reply("terminable", "GetStatus", {}, Schema.Void)

    const { spawn } = fromMachine({
      id: "terminable",
      built: counterMachine,
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start

      const exit = yield* actor.ask(GetStatus()).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ExtensionProtocolError)
        expect((error as ExtensionProtocolError).phase).toBe("request")
        expect((error as ExtensionProtocolError).message).toContain(
          'extension "terminable" does not handle request "GetStatus"',
        )
      }
    }).pipe(Effect.provide(testLayer))
  })

  it.live("spawn is cold until actor.start", () => {
    const GetStatus = ExtensionMessage.reply("machine-cold", "GetStatus", {}, Schema.Void)

    const { spawn } = fromMachine({
      id: "machine-cold",
      built: counterMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return CounterEvent.Start
        return undefined
      },
      mapMessage: () => CounterEvent.Start,
      messageSchema: Schema.Struct({ action: Schema.String }),
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      const beforeStart = [
        actor.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId }),
        actor.send({ extensionId: "machine-cold", _tag: "Message", action: "start" }),
        actor.ask(GetStatus()),
        actor.snapshot,
      ] as const

      for (const effect of beforeStart) {
        const exit = yield* effect.pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(ExtensionProtocolError)
          expect((error as ExtensionProtocolError).phase).toBe("lifecycle")
          expect((error as ExtensionProtocolError).message).toContain(
            'extension "machine-cold" actor used before start()',
          )
        }
      }

      yield* actor.start
      const snapshot = yield* actor.snapshot
      expect((snapshot.state as CounterState)._tag).toBe("Idle")
    }).pipe(Effect.provide(testLayer))
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
    // UI-only (no context)
    const ui = projection!.derive!({ _tag: "Counting", count: 5 }, undefined)
    expect(ui?.uiModel).toEqual({ tag: "Counting" })
  })

  test("derive with ctx.agent access works with optional ctx", () => {
    const { projection } = fromMachine({
      id: "ctx-test",
      built: counterMachine,
      derive: (state, ctx?) => ({
        uiModel: { tag: state._tag, agentName: ctx?.agent.name ?? "none" },
      }),
    })

    const deriveFn = projection?.derive
    expect(deriveFn).toBeInstanceOf(Function)
    // With context
    const withCtx = deriveFn?.(
      { _tag: "Idle" },
      {
        agent: { name: "test" } as never,
        allTools: [],
      },
    )
    const withCtxModel = withCtx?.uiModel as { agentName: string } | undefined
    expect(withCtxModel?.agentName).toBe("test")
    // Without context
    const noCtx = deriveFn?.({ _tag: "Idle" }, undefined)
    const noCtxModel = noCtx?.uiModel as { agentName: string } | undefined
    expect(noCtxModel?.agentName).toBe("none")
  })

  test("no projection when derive not provided", () => {
    const { projection } = fromMachine({
      id: "no-derive",
      built: counterMachine,
    })

    expect(projection).toBeUndefined()
  })

  it.live("persistence: state hydrated on init", () => {
    const CounterStateSchema = CounterState

    const { spawn, projection } = fromMachine({
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
      setup: { spawn, projection },
    }

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live([ext]),
      EventStore.Memory,
      ExtensionTurnControl.Test(),
      Storage.Test(),
    )

    return Effect.gen(function* () {
      const storage = yield* Storage

      // Pre-seed persisted state
      yield* storage.saveExtensionState({
        sessionId,
        extensionId: "persist-counter",
        stateJson: JSON.stringify({ _tag: "Counting", count: 42 }),
        version: 7,
      })

      const runtime = yield* ExtensionStateRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const counter = snapshots.find((s) => s.extensionId === "persist-counter")
      expect(counter).toBeDefined()
      expect(counter!.epoch).toBe(7)
      expect(counter!.model).toEqual({ tag: "Counting" })
    }).pipe(Effect.provide(layer))
  })

  it.live("transition defect is logged as warning, not silently swallowed", () => {
    // Machine where the Explode transition throws a defect
    const BombState = MState({ Armed: {}, Disarmed: {} })
    const BombEvent = MEvent({ Explode: {} })

    const bombMachine = Machine.make({
      state: BombState,
      event: BombEvent,
      initial: BombState.Armed,
    }).on(BombState.Armed, BombEvent.Explode, () => {
      throw new Error("boom")
    })

    const { spawn } = fromMachine({
      id: "bomb",
      built: bombMachine,
      mapEvent: (event) => {
        if (event._tag === "SessionStarted") return BombEvent.Explode
        return undefined
      },
    })

    // Mutable array — Logger.make callback is synchronous, no Effect needed
    const captured: Array<{ message: string; annotations: Record<string, unknown> }> = []

    const captureLogger = Logger.make(({ logLevel, message, fiber }) => {
      if (logLevel !== "Warn") return
      const msg = typeof message === "string" ? message : String(message)
      const annotations = fiber.getRef(CurrentLogAnnotations) as Record<string, unknown>
      captured.push({ message: msg, annotations })
    })

    const logLayer = Logger.layer([captureLogger])

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start

      const changed = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })

      // Defect caught → returns false (no transition)
      expect(changed).toBe(false)

      // But the warning was logged, not silently swallowed
      const defectLog = captured.find((e) => e.message === "machine transition defect")
      expect(defectLog).toBeDefined()
      expect(defectLog!.annotations).toMatchObject({ extensionId: "bomb" })
      // Defect string should contain "boom"
      expect(String(defectLog!.annotations.defect)).toContain("boom")
    }).pipe(Effect.provide(Layer.mergeAll(testLayer, logLayer)))
  })
})
