import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Ref, Schema } from "effect"
import { EventStore, SessionStarted, TurnCompleted } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type {
  ExtensionReduceContext,
  LoadedExtension,
  ReduceResult,
} from "@gent/core/domain/extension"
import { ExtensionMessage, ExtensionProtocolError } from "@gent/core/domain/extension-protocol"
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
      yield* actor.start
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

  it.live("send effects target correct branch", () =>
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
      yield* actor.start
      // getState works
      const snap = yield* actor.snapshot
      expect(snap.state).toEqual({ mode: "normal" })
    }).pipe(Effect.provide(testLayer))
  })

  it.live("send validates schema and updates state", () =>
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
        yield* actor.start
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
      yield* actor.start
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
      yield* actor.start
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
      yield* actor.start
      const ctx: ExtensionReduceContext = { sessionId, branchId }

      // Defect caught — state unchanged
      yield* actor
        .publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), ctx)
        .pipe(Effect.catchDefect(() => Effect.void))

      const snap = yield* actor.snapshot
      expect((snap.state as { value: string }).value).toBe("ok")
    }).pipe(Effect.provide(testLayer))
  })

  it.live("spawn is cold until actor.start", () => {
    const Request = ExtensionMessage.reply("cold-start", "Ping", {}, Schema.Void)

    const { spawn } = fromReducer<{ value: string }>({
      id: "cold-start",
      initial: { value: "cold" },
      reduce: (state) => ({ state }),
    })

    return Effect.gen(function* () {
      const actor = yield* spawn({ sessionId, branchId })
      const beforeStart = [
        actor.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId }),
        actor.send({ extensionId: "cold-start", _tag: "Message" }),
        actor.ask(Request()),
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
            'extension "cold-start" actor used before start()',
          )
        }
      }

      yield* actor.start
      const snapshot = yield* actor.snapshot
      expect(snapshot.state).toEqual({ value: "cold" })
      expect(snapshot.epoch).toBe(0)
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
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
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

  it.live("spawn failures are isolated and exposed as actor lifecycle state", () => {
    const { spawn, projection } = fromReducer({
      id: "healthy-actor",
      initial: { count: 0 },
      reduce: (state: { count: number }) => ({ state: { count: state.count + 1 } }),
      derive: (state: { count: number }) => ({ uiModel: state }),
    })

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "healthy-actor" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { spawn, projection },
      },
      {
        manifest: { id: "broken-actor" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          spawn: () =>
            Effect.sync(() => {
              throw new Error("spawn boom")
            }),
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const changed = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(changed).toBe(true)
      expect(snapshots.map((snapshot) => snapshot.extensionId)).toEqual(["healthy-actor"])
      expect(statuses).toEqual([
        {
          extensionId: "healthy-actor",
          sessionId,
          branchId,
          status: "running",
        },
        {
          extensionId: "broken-actor",
          sessionId,
          branchId,
          status: "failed",
          error: "Error: spawn boom",
          failurePhase: "start",
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live("runtime publish failure restarts actor once and retries the event", () => {
    let spawnCount = 0
    const stopped: number[] = []

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "flaky-publisher" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          projection: {
            derive: (state) => ({ uiModel: state }),
          },
          spawn: () => {
            spawnCount++
            const generation = spawnCount
            return Effect.succeed({
              id: "flaky-publisher",
              start: Effect.void,
              publish: () =>
                generation === 1
                  ? Effect.sync(() => {
                      throw new Error("publish boom")
                    })
                  : Effect.succeed(true),
              send: () => Effect.void,
              ask: () => Effect.die("not implemented"),
              snapshot: Effect.succeed({ state: { generation }, epoch: generation }),
              stop: Effect.sync(() => {
                stopped.push(generation)
              }),
            })
          },
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const changed = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(changed).toBe(true)
      expect(spawnCount).toBe(2)
      expect(stopped).toEqual([1])
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]!.model).toEqual({ generation: 2 })
      expect(statuses).toEqual([
        {
          extensionId: "flaky-publisher",
          sessionId,
          branchId,
          status: "running",
          restartCount: 1,
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "repeated runtime publish failure exhausts restart budget and leaves terminal failed state",
    () => {
      let spawnCount = 0
      const stopped: number[] = []

      const extensions: LoadedExtension[] = [
        {
          manifest: { id: "terminal-publisher" },
          kind: "builtin",
          sourcePath: "builtin",
          setup: {
            projection: {
              derive: (state) => ({ uiModel: state }),
            },
            spawn: () => {
              spawnCount++
              const generation = spawnCount
              return Effect.succeed({
                id: "terminal-publisher",
                start: Effect.void,
                publish: () =>
                  Effect.sync(() => {
                    throw new Error(`publish boom ${generation}`)
                  }),
                send: () => Effect.void,
                ask: () => Effect.die("not implemented"),
                snapshot: Effect.succeed({ state: { generation }, epoch: generation }),
                stop: Effect.sync(() => {
                  stopped.push(generation)
                }),
              })
            },
          },
        },
      ]

      const layer = Layer.mergeAll(
        ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
        EventStore.Memory,
        testLayer,
      )

      return Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime

        const changed = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
        const statuses = yield* runtime.getActorStatuses(sessionId)

        expect(changed).toBe(false)
        expect(spawnCount).toBe(2)
        expect(stopped).toEqual([1, 2])
        expect(snapshots).toEqual([])
        expect(statuses).toEqual([
          {
            extensionId: "terminal-publisher",
            sessionId,
            branchId,
            status: "failed",
            restartCount: 1,
            failurePhase: "runtime",
            error: "Error: publish boom 2",
          },
        ])

        const changedAgain = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
          sessionId,
          branchId,
        })
        expect(changedAgain).toBe(false)
        expect(spawnCount).toBe(2)
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("send normalizes actor command failures to ExtensionProtocolError", () => {
    const Ping = ExtensionMessage("broken-command", "Ping", {})

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "broken-command" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          protocols: [Ping],
          spawn: () =>
            Effect.succeed({
              id: "broken-command",
              start: Effect.void,
              publish: () => Effect.succeed(false),
              send: () =>
                Effect.sync(() => {
                  throw new Error("command boom")
                }),
              ask: () => Effect.die("not implemented"),
              snapshot: Effect.succeed({ state: {}, epoch: 0 }),
              stop: Effect.void,
            }),
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const exit = yield* Effect.exit(runtime.send(sessionId, Ping({}), branchId))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(ExtensionProtocolError)
      expect((failure as ExtensionProtocolError).phase).toBe("command")
      expect((failure as ExtensionProtocolError).message).toContain("command boom")
    }).pipe(Effect.provide(layer))
  })

  it.live("runtime send failure restarts actor once and retries the command", () => {
    const Ping = ExtensionMessage("flaky-command", "Ping", {})
    let spawnCount = 0
    const stopped: number[] = []

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "flaky-command" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          protocols: [Ping],
          spawn: () => {
            spawnCount++
            const generation = spawnCount
            return Effect.succeed({
              id: "flaky-command",
              start: Effect.void,
              publish: () => Effect.succeed(false),
              send: () =>
                generation === 1
                  ? Effect.sync(() => {
                      throw new Error("command boom")
                    })
                  : Effect.void,
              ask: () => Effect.die("not implemented"),
              snapshot: Effect.succeed({ state: { generation }, epoch: generation }),
              stop: Effect.sync(() => {
                stopped.push(generation)
              }),
            })
          },
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.send(sessionId, Ping({}), branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(spawnCount).toBe(2)
      expect(stopped).toEqual([1])
      expect(statuses).toEqual([
        {
          extensionId: "flaky-command",
          sessionId,
          branchId,
          status: "running",
          restartCount: 1,
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "terminal send failure leaves later commands as protocol errors, not silent no-ops",
    () => {
      const Ping = ExtensionMessage("terminal-command", "Ping", {})
      let spawnCount = 0
      const stopped: number[] = []

      const extensions: LoadedExtension[] = [
        {
          manifest: { id: "terminal-command" },
          kind: "builtin",
          sourcePath: "builtin",
          setup: {
            protocols: [Ping],
            spawn: () => {
              spawnCount++
              const generation = spawnCount
              return Effect.succeed({
                id: "terminal-command",
                start: Effect.void,
                publish: () => Effect.succeed(false),
                send: () =>
                  Effect.sync(() => {
                    throw new Error(`command boom ${generation}`)
                  }),
                ask: () => Effect.die("not implemented"),
                snapshot: Effect.succeed({ state: { generation }, epoch: generation }),
                stop: Effect.sync(() => {
                  stopped.push(generation)
                }),
              })
            },
          },
        },
      ]

      const layer = Layer.mergeAll(
        ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
        EventStore.Memory,
        testLayer,
      )

      return Effect.gen(function* () {
        const runtime = yield* ExtensionStateRuntime

        const firstExit = yield* Effect.exit(runtime.send(sessionId, Ping({}), branchId))
        expect(firstExit._tag).toBe("Failure")
        if (firstExit._tag === "Failure") {
          const failure = Cause.squash(firstExit.cause)
          expect(failure).toBeInstanceOf(ExtensionProtocolError)
          expect((failure as ExtensionProtocolError).phase).toBe("command")
          expect((failure as ExtensionProtocolError).message).toContain("command boom 2")
        }

        const secondExit = yield* Effect.exit(runtime.send(sessionId, Ping({}), branchId))
        expect(secondExit._tag).toBe("Failure")
        if (secondExit._tag === "Failure") {
          const failure = Cause.squash(secondExit.cause)
          expect(failure).toBeInstanceOf(ExtensionProtocolError)
          expect((failure as ExtensionProtocolError).phase).toBe("command")
          expect((failure as ExtensionProtocolError).message).toContain(
            'extension "terminal-command" is not loaded',
          )
        }

        const statuses = yield* runtime.getActorStatuses(sessionId)
        expect(spawnCount).toBe(2)
        expect(stopped).toEqual([1, 2])
        expect(statuses).toEqual([
          {
            extensionId: "terminal-command",
            sessionId,
            branchId,
            status: "failed",
            restartCount: 1,
            failurePhase: "runtime",
            error: "Error: command boom 2",
          },
        ])
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("ask normalizes actor reply failures to ExtensionProtocolError", () => {
    const Ping = ExtensionMessage.reply("broken-request", "Ping", {}, Schema.String)

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "broken-request" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          protocols: [Ping],
          spawn: () =>
            Effect.succeed({
              id: "broken-request",
              start: Effect.void,
              publish: () => Effect.succeed(false),
              send: () => Effect.void,
              ask: () =>
                Effect.sync(() => {
                  throw new Error("reply boom")
                }),
              snapshot: Effect.succeed({ state: {}, epoch: 0 }),
              stop: Effect.void,
            }),
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const exit = yield* Effect.exit(runtime.ask(sessionId, Ping({}), branchId))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Success") return
      const failure = Cause.squash(exit.cause)
      expect(failure).toBeInstanceOf(ExtensionProtocolError)
      expect((failure as ExtensionProtocolError).phase).toBe("reply")
      expect((failure as ExtensionProtocolError).message).toContain("reply boom")
    }).pipe(Effect.provide(layer))
  })

  it.live("runtime ask failure restarts actor once and retries the request", () => {
    const Ping = ExtensionMessage.reply(
      "flaky-request",
      "Ping",
      {},
      Schema.Struct({ generation: Schema.Number }),
    )
    let spawnCount = 0
    const stopped: number[] = []

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "flaky-request" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          protocols: [Ping],
          spawn: () => {
            spawnCount++
            const generation = spawnCount
            return Effect.succeed({
              id: "flaky-request",
              start: Effect.void,
              publish: () => Effect.succeed(false),
              send: () => Effect.void,
              ask: () =>
                generation === 1
                  ? Effect.sync(() => {
                      throw new Error("reply boom")
                    })
                  : Effect.succeed({ generation }),
              snapshot: Effect.succeed({ state: { generation }, epoch: generation }),
              stop: Effect.sync(() => {
                stopped.push(generation)
              }),
            })
          },
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const reply = yield* runtime.ask(sessionId, Ping({}), branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(reply).toEqual({ generation: 2 })
      expect(spawnCount).toBe(2)
      expect(stopped).toEqual([1])
      expect(statuses).toEqual([
        {
          extensionId: "flaky-request",
          sessionId,
          branchId,
          status: "running",
          restartCount: 1,
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live("snapshot restart during deriveAll preserves actor branch identity", () => {
    let spawnCount = 0
    const stopped: number[] = []

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "flaky-snapshot" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          projection: {
            derive: (state: { generation: number }) => ({
              promptSections: [{ tag: "generation", content: `Generation ${state.generation}` }],
              uiModel: state,
            }),
          },
          spawn: () => {
            spawnCount++
            const generation = spawnCount
            return Effect.succeed({
              id: "flaky-snapshot",
              start: Effect.void,
              publish: () => Effect.succeed(false),
              send: () => Effect.void,
              ask: () => Effect.die("not implemented"),
              snapshot:
                generation === 1
                  ? Effect.sync(() => {
                      throw new Error("snapshot boom")
                    })
                  : Effect.succeed({ state: { generation }, epoch: generation }),
              stop: Effect.sync(() => {
                stopped.push(generation)
              }),
            })
          },
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId })

      const projections = yield* runtime.deriveAll(sessionId, {
        agent: undefined as never,
        allTools: [],
      })
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(projections).toEqual([
        {
          extensionId: "flaky-snapshot",
          projection: {
            promptSections: [{ tag: "generation", content: "Generation 2" }],
          },
        },
      ])
      expect(spawnCount).toBe(2)
      expect(stopped).toEqual([1])
      expect(statuses).toEqual([
        {
          extensionId: "flaky-snapshot",
          sessionId,
          branchId,
          status: "running",
          restartCount: 1,
        },
      ])
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
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
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

  it.live("ask decodes request and reply via registered protocol", () => {
    const Increment = ExtensionMessage.reply(
      "counter",
      "Increment",
      { delta: Schema.Number },
      Schema.Struct({ count: Schema.Number }),
    )

    const { spawn } = fromReducer<{ count: number }, never, ReturnType<typeof Increment>>({
      id: "counter",
      initial: { count: 0 },
      reduce: (state) => ({ state }),
      request: (state, message) =>
        Effect.succeed({
          state: { count: state.count + message.delta },
          reply: { count: state.count + message.delta },
        }),
    })

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "counter" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          spawn,
          protocols: [Increment],
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const reply = yield* runtime.ask(sessionId, Increment({ delta: 2 }), branchId)
      expect(reply).toEqual({ count: 2 })
    }).pipe(Effect.provide(layer))
  })

  it.live("ask rejects invalid replies against the registered protocol", () => {
    const GetCount = ExtensionMessage.reply(
      "counter",
      "GetCount",
      {},
      Schema.Struct({ count: Schema.Number }),
    )

    const { spawn } = fromReducer<{ count: number }, never, ReturnType<typeof GetCount>>({
      id: "counter",
      initial: { count: 0 },
      reduce: (state) => ({ state }),
      request: (state) =>
        Effect.succeed({
          state,
          reply: { count: "not-a-number" } as unknown,
        }),
    })

    const extensions: LoadedExtension[] = [
      {
        manifest: { id: "counter" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          spawn,
          protocols: [GetCount],
        },
      },
    ]

    const layer = Layer.mergeAll(
      ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
      EventStore.Memory,
      testLayer,
    )

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const exit = yield* runtime.ask(sessionId, GetCount(), branchId).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(ExtensionProtocolError)
          expect(error.value.phase).toBe("reply")
          expect(error.value.message).toContain("Expected number")
        }
      }
    }).pipe(Effect.provide(layer))
  })
})
