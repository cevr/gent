import { describe, test, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type { ExtensionReduceContext, ReduceResult } from "@gent/core/domain/extension"
import { fromReducer } from "@gent/core/runtime/extensions/from-reducer"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"

const sessionId = "test-session" as SessionId
const branchId = "test-branch" as BranchId

const testLayer = Layer.mergeAll(ExtensionTurnControl.Test(), ExtensionEventBus.Test())

describe("fromReducer", () => {
  test("basic state transition", async () => {
    const spawn = fromReducer<{ count: number }>({
      id: "counter",
      initial: { count: 0 },
      reduce: (state, _event) => ({ state: { count: state.count + 1 } }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.init

        const before = yield* actor.snapshot
        expect(before.state).toEqual({ count: 0 })
        expect(before.version).toBe(0)

        yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const after = yield* actor.snapshot
        expect(after.state).toEqual({ count: 1 })
        expect(after.version).toBe(1)

        yield* actor.terminate
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("no state change preserves version", async () => {
    const spawn = fromReducer<{ value: string }>({
      id: "stable",
      initial: { value: "unchanged" },
      reduce: (state) => ({ state }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        const snap = yield* actor.snapshot
        expect(snap.version).toBe(0)
        expect(snap.state).toEqual({ value: "unchanged" })
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("effects are interpreted", async () => {
    const emitted = Effect.runSync(Ref.make<string[]>([]))

    const spawn = fromReducer<{ active: boolean }>({
      id: "effector",
      initial: { active: false },
      reduce: (state, event): ReduceResult<{ active: boolean }> => {
        if (event._tag === "TurnCompleted") {
          return {
            state: { active: true },
            effects: [{ _tag: "EmitEvent", channel: "test:done", payload: { ok: true } }],
          }
        }
        return { state }
      },
    })

    // Custom event bus that captures emits
    const busLayer = Layer.succeed(ExtensionEventBus, {
      emit: (channel: string, _payload: unknown) => Ref.update(emitted, (arr) => [...arr, channel]),
      on: () => Effect.void,
      off: () => Effect.void,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.handleEvent(new TurnCompleted({ sessionId, branchId, durationMs: 100 }), {
          sessionId,
          branchId,
        })

        const snap = yield* actor.snapshot
        expect(snap.state).toEqual({ active: true })

        const channels = yield* Ref.get(emitted)
        expect(channels).toContain("test:done")
      }).pipe(Effect.provide(Layer.merge(ExtensionTurnControl.Test(), busLayer))),
    )
  })

  test("derive produces projections", async () => {
    const spawn = fromReducer<{ mode: string }>({
      id: "projector",
      initial: { mode: "normal" },
      reduce: (state) => ({ state }),
      derive: (state) => ({
        promptSections: [{ tag: "mode", content: `Mode: ${state.mode}` }],
        uiModel: { mode: state.mode },
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        expect(actor.derive).toBeDefined()
        const projection = actor.derive!(
          { mode: "plan" },
          { agent: undefined as never, allTools: [] },
        )
        expect(projection.uiModel).toEqual({ mode: "plan" })
        expect(projection.promptSections).toHaveLength(1)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("handleIntent with schema validation", async () => {
    const { Schema } = await import("effect")

    const IntentSchema = Schema.Struct({
      action: Schema.Literals(["activate", "deactivate"]),
    })

    const spawn = fromReducer({
      id: "intent-handler",
      initial: { active: false },
      reduce: (state: { active: boolean }) => ({ state }),
      handleIntent: (state: { active: boolean }, intent: typeof IntentSchema.Type) => ({
        state: { active: intent.action === "activate" },
      }),
      intentSchema: IntentSchema,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        expect(actor.handleIntent).toBeDefined()

        yield* actor.handleIntent!({ action: "activate" })
        const snap = yield* actor.snapshot
        expect(snap.state).toEqual({ active: true })
        expect(snap.version).toBe(1)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("multiple events accumulate state", async () => {
    const spawn = fromReducer<{ seen: string[] }>({
      id: "accumulator",
      initial: { seen: [] },
      reduce: (state, event) => ({
        state: { seen: [...state.seen, event._tag] },
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        const ctx: ExtensionReduceContext = { sessionId, branchId }
        yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), ctx)
        yield* actor.handleEvent(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), ctx)

        const snap = yield* actor.snapshot
        const state = snap.state as { seen: string[] }
        expect(state.seen).toEqual(["SessionStarted", "TurnCompleted"])
        expect(snap.version).toBe(2)
      }).pipe(Effect.provide(testLayer)),
    )
  })
})
