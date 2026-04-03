import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, Ref, Schema } from "effect"
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

const sessionId = "test-session" as SessionId
const branchId = "test-branch" as BranchId

const testLayer = ExtensionTurnControl.Test()

describe("fromReducer", () => {
  it.live("handleEvent advances state and increments epoch", () => {
    const { spawn } = fromReducer<{ count: number }>({
      id: "counter",
      initial: { count: 0 },
      reduce: (state, _event) => ({ state: { count: state.count + 1 } }),
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      yield* actor.start

      const before = yield* actor.snapshot
      expect(before.state).toEqual({ count: 0 })
      expect(before.epoch).toBe(0)

      const changed = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed).toBe(true)

      const after = yield* actor.snapshot
      expect(after.state).toEqual({ count: 1 })
      expect(after.epoch).toBe(1)

      yield* actor.stop
    }).pipe(Effect.provide(testLayer))
  })

  it.live("epoch unchanged when reducer returns same state", () => {
    const { spawn } = fromReducer<{ value: string }>({
      id: "stable",
      initial: { value: "unchanged" },
      reduce: (state) => ({ state }),
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      const changed = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed).toBe(false)

      const snap = yield* actor.snapshot
      expect(snap.epoch).toBe(0)
      expect(snap.state).toEqual({ value: "unchanged" })
    }).pipe(Effect.provide(testLayer))
  })

  it.live("effects use current branch context, not spawn-time branch", () =>
    Effect.gen(function* () {
      const followUps = yield* Ref.make<string[]>([])
      const spawnBranch = "branch-A" as BranchId
      const eventBranch = "branch-B" as BranchId

      const { spawn } = fromReducer<{ count: number }>({
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

      yield* Effect.gen(function* () {
        // Spawn on branch A
        const actor = yield* spawn({ sessionId, branchId: spawnBranch })
        yield* actor.start

        // Dispatch event on branch B — effects should target branch B
        yield* actor.publish(
          new TurnCompleted({ sessionId, branchId: eventBranch, durationMs: 50 }),
          { sessionId, branchId: eventBranch },
        )

        const branches = yield* Ref.get(followUps)
        expect(branches).toEqual([eventBranch])
        // Must NOT contain spawn-time branch A
        expect(branches).not.toContain(spawnBranch)
      }).pipe(Effect.provide(turnControlLayer))
    }),
  )

  it.live("handleIntent effects target correct branch", () =>
    Effect.gen(function* () {
      const followUps = yield* Ref.make<string[]>([])
      const spawnBranch = "branch-spawn" as BranchId
      const intentBranch = "branch-intent" as BranchId

      const IntentSchema = Schema.Struct({ action: Schema.String })

      const { spawn } = fromReducer({
        id: "intent-branch",
        initial: { value: "off" },
        reduce: (state: { value: string }) => ({ state }),
        receive: (_state: { value: string }, _intent: typeof IntentSchema.Type) => ({
          state: { value: "on" },
          effects: [{ _tag: "QueueFollowUp" as const, content: "intent-followup" }],
        }),
        messageSchema: IntentSchema,
      })

      const turnControlLayer = Layer.succeed(ExtensionTurnControl, {
        queueFollowUp: (params: { branchId: BranchId }) =>
          Ref.update(followUps, (arr) => [...arr, params.branchId]),
        interject: () => Effect.void,
      })

      yield* Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId: spawnBranch })
        yield* actor.start

        // Send intent with different branch
        yield* actor.send(
          { extensionId: "intent-branch", _tag: "Message", action: "go" },
          intentBranch,
        )

        const branches = yield* Ref.get(followUps)
        expect(branches).toEqual([intentBranch])
      }).pipe(Effect.provide(turnControlLayer))
    }),
  )

  it.live("projection registered separately from actor", () => {
    const { spawn, projection } = fromReducer<{ mode: string }>({
      id: "projector",
      initial: { mode: "normal" },
      reduce: (state) => ({ state }),
      derive: (state) => ({
        promptSections: [{ tag: "mode", content: `Mode: ${state.mode}` }],
        uiModel: { mode: state.mode },
      }),
    })

    expect(projection).toBeDefined()
    // Turn projection — with context
    const turn = projection!.derive!({ mode: "plan" }, { agent: undefined as never, allTools: [] })
    expect(turn.promptSections).toHaveLength(1)
    // UI projection — without context
    const ui = projection!.derive!({ mode: "plan" }, undefined)
    expect(ui?.uiModel).toEqual({ mode: "plan" })

    // Actor itself has no derive — projection is framework-owned
    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      // getState works
      const snap = yield* actor.snapshot
      expect(snap.state).toEqual({ mode: "normal" })
    }).pipe(Effect.provide(testLayer))
  })

  it.live("handleIntent validates schema and updates state", () =>
    Effect.gen(function* () {
      const IntentSchema = Schema.Struct({
        action: Schema.Literals(["activate", "deactivate"]),
      })

      const { spawn } = fromReducer({
        id: "intent-handler",
        initial: { active: false },
        reduce: (state: { active: boolean }) => ({ state }),
        receive: (_state: { active: boolean }, intent: typeof IntentSchema.Type) => ({
          state: { active: intent.action === "activate" },
        }),
        messageSchema: IntentSchema,
      })

      yield* Effect.gen(function* () {
        const actor = yield* spawn({ sessionId, branchId })
        yield* actor.send({ extensionId: "intent-handler", _tag: "Message", action: "activate" })
        const snap = yield* actor.snapshot
        expect(snap.state).toEqual({ active: true })
        expect(snap.epoch).toBe(1)
      }).pipe(Effect.provide(testLayer))
    }),
  )

  it.live("multiple events accumulate state and epoch", () => {
    const { spawn } = fromReducer<{ seen: string[] }>({
      id: "accumulator",
      initial: { seen: [] },
      reduce: (state, event) => ({
        state: { seen: [...state.seen, event._tag] },
      }),
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      const ctx: ExtensionReduceContext = { sessionId, branchId }
      yield* actor.publish(new SessionStarted({ sessionId, branchId }), ctx)
      yield* actor.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), ctx)

      const snap = yield* actor.snapshot
      const state = snap.state as { seen: string[] }
      expect(state.seen).toEqual(["SessionStarted", "TurnCompleted"])
      expect(snap.epoch).toBe(2)
    }).pipe(Effect.provide(testLayer))
  })

  it.live("concurrent state updates are serialized", () => {
    let reduceCount = 0
    const { spawn } = fromReducer<{ count: number }>({
      id: "atomic",
      initial: { count: 0 },
      reduce: (state) => {
        reduceCount++
        return { state: { count: state.count + 1 } }
      },
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      const ctx: ExtensionReduceContext = { sessionId, branchId }

      for (let i = 0; i < 10; i++) {
        yield* actor.publish(new SessionStarted({ sessionId, branchId }), ctx)
      }

      const snap = yield* actor.snapshot
      expect((snap.state as { count: number }).count).toBe(10)
      expect(snap.epoch).toBe(10)
      expect(reduceCount).toBe(10)
    }).pipe(Effect.provide(testLayer))
  })

  it.live("defect in reducer is catchable by supervision", () => {
    const { spawn } = fromReducer<{ value: string }>({
      id: "crasher",
      initial: { value: "ok" },
      reduce: (_state, event) => {
        if (event._tag === "TurnCompleted") throw new Error("boom")
        return { state: { value: "updated" } }
      },
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      const ctx: ExtensionReduceContext = { sessionId, branchId }

      // Defect caught — state unchanged
      yield* actor
        .publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), ctx)
        .pipe(Effect.catchDefect(() => Effect.void))

      const snap = yield* actor.snapshot
      expect((snap.state as { value: string }).value).toBe("ok")
    }).pipe(Effect.provide(testLayer))
  })
})

describe("ExtensionStateRuntime — actor hosting", () => {
  it.live("actor state changes return changed=true from reduce", () => {
    const { spawn, projection } = fromReducer({
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
        setup: { spawn, projection },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const changed = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.live("terminateAll calls actor.stop and removes session", () => {
    const terminated: string[] = []
    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "terminable" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          spawn: (_ctx) =>
            Effect.gen(function* () {
              yield* ExtensionTurnControl
              return {
                id: "terminable",
                start: Effect.void,
                publish: () => Effect.succeed(false),
                send: () => Effect.void,
                ask: () => Effect.die("not implemented"),
                snapshot: Effect.succeed({ state: {}, epoch: 0 }),
                stop: Effect.sync(() => {
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

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      // Trigger actor spawn via reduce
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })
      yield* runtime.terminateAll(sessionId)
      expect(terminated).toContain("terminable")
    }).pipe(Effect.provide(layer))
  })
})
