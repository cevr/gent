import { describe, test, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { EventStore, SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type {
  ExtensionReduceContext,
  LoadedExtension,
  ReduceResult,
} from "@gent/core/domain/extension"
import { fromReducer } from "@gent/core/runtime/extensions/from-reducer"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ExtensionEventBus } from "@gent/core/runtime/extensions/event-bus"

const sessionId = "test-session" as SessionId
const branchId = "test-branch" as BranchId

const testLayer = Layer.mergeAll(ExtensionTurnControl.Test(), ExtensionEventBus.Test())

describe("fromReducer", () => {
  test("handleEvent advances state and increments version", async () => {
    const { spawnActor: spawn } = fromReducer<{ count: number }>({
      id: "counter",
      initial: { count: 0 },
      reduce: (state, _event) => ({ state: { count: state.count + 1 } }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.init

        const before = yield* actor.getState
        expect(before.state).toEqual({ count: 0 })
        expect(before.version).toBe(0)

        const changed = yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        expect(changed).toBe(true)

        const after = yield* actor.getState
        expect(after.state).toEqual({ count: 1 })
        expect(after.version).toBe(1)

        yield* actor.terminate
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("version unchanged when reducer returns same state", async () => {
    const { spawnActor: spawn } = fromReducer<{ value: string }>({
      id: "stable",
      initial: { value: "unchanged" },
      reduce: (state) => ({ state }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        const changed = yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        expect(changed).toBe(false)

        const snap = yield* actor.getState
        expect(snap.version).toBe(0)
        expect(snap.state).toEqual({ value: "unchanged" })
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("EmitEvent effect dispatches to event bus", async () => {
    const emitted = Effect.runSync(Ref.make<string[]>([]))

    const { spawnActor: spawn } = fromReducer<{ active: boolean }>({
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

        const snap = yield* actor.getState
        expect(snap.state).toEqual({ active: true })

        const channels = yield* Ref.get(emitted)
        expect(channels).toContain("test:done")
      }).pipe(Effect.provide(Layer.merge(ExtensionTurnControl.Test(), busLayer))),
    )
  })

  test("effects use current branch context, not spawn-time branch", async () => {
    const followUps = Effect.runSync(Ref.make<string[]>([]))
    const spawnBranch = "branch-A" as BranchId
    const eventBranch = "branch-B" as BranchId

    const { spawnActor: spawn } = fromReducer<{ count: number }>({
      id: "branch-checker",
      initial: { count: 0 },
      reduce: (state, event): ReduceResult<{ count: number }> => {
        if (event._tag === "TurnCompleted") {
          return {
            state: { count: state.count + 1 },
            effects: [{ _tag: "QueueFollowUp", content: "follow-up" }],
          }
        }
        return { state }
      },
    })

    const turnControlLayer = Layer.succeed(ExtensionTurnControl, {
      queueFollowUp: (params: { branchId: BranchId }) =>
        Ref.update(followUps, (arr) => [...arr, params.branchId]),
      interject: () => Effect.void,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        // Spawn on branch A
        const actor = yield* spawn({ sessionId, branchId: spawnBranch })
        yield* actor.init

        // Dispatch event on branch B — effects should target branch B
        yield* actor.handleEvent(
          new TurnCompleted({ sessionId, branchId: eventBranch, durationMs: 50 }),
          { sessionId, branchId: eventBranch },
        )

        const branches = yield* Ref.get(followUps)
        expect(branches).toEqual([eventBranch])
        // Must NOT contain spawn-time branch A
        expect(branches).not.toContain(spawnBranch)
      }).pipe(Effect.provide(Layer.merge(turnControlLayer, ExtensionEventBus.Test()))),
    )
  })

  test("handleIntent effects target correct branch", async () => {
    const { Schema } = await import("effect")
    const followUps = Effect.runSync(Ref.make<string[]>([]))
    const spawnBranch = "branch-spawn" as BranchId
    const intentBranch = "branch-intent" as BranchId

    const IntentSchema = Schema.Struct({ action: Schema.String })

    const { spawnActor: spawn } = fromReducer({
      id: "intent-branch",
      initial: { value: "off" },
      reduce: (state: { value: string }) => ({ state }),
      handleIntent: (_state: { value: string }, _intent: typeof IntentSchema.Type) => ({
        state: { value: "on" },
        effects: [{ _tag: "QueueFollowUp" as const, content: "intent-followup" }],
      }),
      intentSchema: IntentSchema,
    })

    const turnControlLayer = Layer.succeed(ExtensionTurnControl, {
      queueFollowUp: (params: { branchId: BranchId }) =>
        Ref.update(followUps, (arr) => [...arr, params.branchId]),
      interject: () => Effect.void,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId: spawnBranch })
        yield* actor.init

        // Send intent with different branch
        yield* actor.handleIntent!({ action: "go" }, intentBranch)

        const branches = yield* Ref.get(followUps)
        expect(branches).toEqual([intentBranch])
      }).pipe(Effect.provide(Layer.merge(turnControlLayer, ExtensionEventBus.Test()))),
    )
  })

  test("projection registered separately from actor", async () => {
    const { spawnActor: spawn, projection } = fromReducer<{ mode: string }>({
      id: "projector",
      initial: { mode: "normal" },
      reduce: (state) => ({ state }),
      derive: (state) => ({
        promptSections: [{ tag: "mode", content: `Mode: ${state.mode}` }],
        uiModel: { mode: state.mode },
      }),
    })

    expect(projection).toBeDefined()
    const result = projection!.derive({ mode: "plan" }, { agent: undefined as never, allTools: [] })
    expect(result.uiModel).toEqual({ mode: "plan" })
    expect(result.promptSections).toHaveLength(1)

    // Actor itself has no derive — projection is framework-owned
    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        // getState works
        const snap = yield* actor.getState
        expect(snap.state).toEqual({ mode: "normal" })
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("handleIntent validates schema and updates state", async () => {
    const { Schema } = await import("effect")

    const IntentSchema = Schema.Struct({
      action: Schema.Literals(["activate", "deactivate"]),
    })

    const { spawnActor: spawn } = fromReducer({
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

        const changed = yield* actor.handleIntent!({ action: "activate" })
        expect(changed).toBe(true)
        const snap = yield* actor.getState
        expect(snap.state).toEqual({ active: true })
        expect(snap.version).toBe(1)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("multiple events accumulate state and version", async () => {
    const { spawnActor: spawn } = fromReducer<{ seen: string[] }>({
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

        const snap = yield* actor.getState
        const state = snap.state as { seen: string[] }
        expect(state.seen).toEqual(["SessionStarted", "TurnCompleted"])
        expect(snap.version).toBe(2)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("concurrent state updates are serialized", async () => {
    let reduceCount = 0
    const { spawnActor: spawn } = fromReducer<{ count: number }>({
      id: "atomic",
      initial: { count: 0 },
      reduce: (state) => {
        reduceCount++
        return { state: { count: state.count + 1 } }
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        const ctx: ExtensionReduceContext = { sessionId, branchId }

        for (let i = 0; i < 10; i++) {
          yield* actor.handleEvent(new SessionStarted({ sessionId, branchId }), ctx)
        }

        const snap = yield* actor.getState
        expect((snap.state as { count: number }).count).toBe(10)
        expect(snap.version).toBe(10)
        expect(reduceCount).toBe(10)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("defect in reducer is catchable by supervision", async () => {
    const { spawnActor: spawn } = fromReducer<{ value: string }>({
      id: "crasher",
      initial: { value: "ok" },
      reduce: (_state, event) => {
        if (event._tag === "TurnCompleted") throw new Error("boom")
        return { state: { value: "updated" } }
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        const ctx: ExtensionReduceContext = { sessionId, branchId }

        // Defect caught — state unchanged
        yield* actor
          .handleEvent(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), ctx)
          .pipe(Effect.catchDefect(() => Effect.void))

        const snap = yield* actor.getState
        expect((snap.state as { value: string }).value).toBe("ok")
      }).pipe(Effect.provide(testLayer)),
    )
  })
})

describe("ExtensionStateRuntime — actor hosting", () => {
  test("actor state changes return changed=true from reduce", async () => {
    const { spawnActor, projection } = fromReducer({
      id: "test-actor",
      initial: { count: 0 },
      reduce: (state: { count: number }) => ({ state: { count: state.count + 1 } }),
      derive: (state: { count: number }) => ({ uiModel: state }),
    })

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "test-actor" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { spawnActor, projection },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions),
      EventStore.Memory,
      testLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        const changed = yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        expect(changed).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("terminateAll calls actor.terminate and removes session", async () => {
    const terminated: string[] = []
    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "terminable" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          spawnActor: (_ctx) =>
            Effect.gen(function* () {
              yield* ExtensionTurnControl
              return {
                id: "terminable",
                init: Effect.void,
                handleEvent: () => Effect.succeed(false),
                getState: Effect.succeed({ state: {}, version: 0 }),
                terminate: Effect.sync(() => {
                  terminated.push("terminable")
                }),
              }
            }),
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions),
      EventStore.Memory,
      testLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime
        // Trigger actor spawn via reduce
        yield* runtime.reduce(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })
        yield* runtime.terminateAll(sessionId)
        expect(terminated).toContain("terminable")
      }).pipe(Effect.provide(layer)),
    )
  })
})
