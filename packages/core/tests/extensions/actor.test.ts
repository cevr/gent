import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { ExtensionMessage, ExtensionProtocolError } from "@gent/core/domain/extension-protocol"
import { EventStore, SessionStarted } from "@gent/core/domain/event"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import type { LoadedExtension } from "@gent/core/domain/extension"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { spawnMachineExtensionRef } from "@gent/core/runtime/extensions/spawn-machine-ref"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { reducerActor } from "./helpers/reducer-actor"

const sessionId = "test-session" as SessionId
const branchId = "test-branch" as BranchId
const testLayer = ExtensionTurnControl.Test()

const makeCounterActor = (id: string) =>
  reducerActor({
    id,
    initial: { count: 0 },
    stateSchema: Schema.Struct({ count: Schema.Number }),
    reduce: (state, event) =>
      event._tag === "SessionStarted" || event._tag === "TurnCompleted"
        ? { state: { count: state.count + 1 } }
        : { state },
    derive: (state) => ({ uiModel: state }),
  })

const makeRuntimeLayer = (extensions: LoadedExtension[]) =>
  Layer.mergeAll(
    ExtensionStateRuntime.Live(extensions).pipe(Layer.provideMerge(testLayer)),
    EventStore.Memory,
    testLayer,
  )

describe("spawnMachineExtensionRef", () => {
  it.live("publish advances state and epoch", () =>
    Effect.gen(function* () {
      const actor = yield* spawnMachineExtensionRef("counter", makeCounterActor("counter"), {
        sessionId,
        branchId,
      }).pipe(Effect.provide(testLayer))

      yield* actor.start

      const before = yield* actor.snapshot
      expect(before.state).toEqual({ _tag: "Active", value: { count: 0 } })
      expect(before.epoch).toBe(0)

      const changed = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed).toBe(true)

      const after = yield* actor.snapshot
      expect(after.state).toEqual({ _tag: "Active", value: { count: 1 } })
      expect(after.epoch).toBe(1)
    }),
  )

  it.live("same-state transition keeps epoch stable", () =>
    Effect.gen(function* () {
      const actor = yield* spawnMachineExtensionRef(
        "stable",
        reducerActor({
          id: "stable",
          initial: { value: "unchanged" },
          stateSchema: Schema.Struct({ value: Schema.String }),
          reduce: (state) => ({ state }),
          derive: (state) => ({ uiModel: state }),
        }),
        { sessionId, branchId },
      ).pipe(Effect.provide(testLayer))

      yield* actor.start
      const changed = yield* actor.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      expect(changed).toBe(false)

      const snapshot = yield* actor.snapshot
      expect(snapshot.epoch).toBe(0)
    }),
  )

  it.live("cold actor rejects use before start", () =>
    Effect.gen(function* () {
      const Ping = ExtensionMessage.reply("cold-start", "Ping", {}, Schema.Void)
      const actor = yield* spawnMachineExtensionRef(
        "cold-start",
        reducerActor({
          id: "cold-start",
          initial: { value: "cold" },
          stateSchema: Schema.Struct({ value: Schema.String }),
          reduce: (state) => ({ state }),
        }),
        { sessionId, branchId },
      ).pipe(Effect.provide(testLayer))

      const effects = [
        actor.publish(new SessionStarted({ sessionId, branchId }), { sessionId, branchId }),
        actor.send({ extensionId: "cold-start", _tag: "Message" }),
        actor.ask(Ping()),
        actor.snapshot,
      ] as const

      for (const effect of effects) {
        const exit = yield* effect.pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(ExtensionProtocolError)
          expect((error as ExtensionProtocolError).phase).toBe("lifecycle")
        }
      }
    }),
  )

  it.live("ask returns replies through the actor boundary", () =>
    Effect.gen(function* () {
      const Increment = ExtensionMessage.reply(
        "counter",
        "Increment",
        { delta: Schema.Number },
        Schema.Struct({ count: Schema.Number }),
      )

      const actor = yield* spawnMachineExtensionRef(
        "counter",
        reducerActor<{ count: number }, never, ReturnType<typeof Increment>>({
          id: "counter",
          initial: { count: 0 },
          stateSchema: Schema.Struct({ count: Schema.Number }),
          reduce: (state) => ({ state }),
          request: (state, message) =>
            Effect.succeed({
              state: { count: state.count + message.delta },
              reply: { count: state.count + message.delta },
            }),
        }),
        { sessionId, branchId },
      ).pipe(Effect.provide(testLayer))

      yield* actor.start
      const reply = yield* actor.ask(Increment({ delta: 2 }))
      expect(reply).toEqual({ count: 2 })
    }),
  )
})

describe("ExtensionStateRuntime", () => {
  it.live("healthy actor still runs when another actor fails during spawn", () => {
    const healthy = makeCounterActor("healthy-actor")
    const broken = {
      ...makeCounterActor("broken-actor"),
      slots: () =>
        Effect.sync(() => {
          throw new Error("spawn boom")
        }),
    }

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "healthy-actor" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor: healthy },
      },
      {
        manifest: { id: "broken-actor" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor: broken },
      },
    ])

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

  it.live("onInit failure degrades the actor instead of marking it running", () => {
    const healthy = makeCounterActor("healthy-after-init-failure")
    const broken = reducerActor({
      id: "broken-on-init",
      initial: { count: 0 },
      stateSchema: Schema.Struct({ count: Schema.Number }),
      reduce: (state) => ({ state }),
      derive: (state) => ({ uiModel: state }),
      onInit: () =>
        Effect.sync(() => {
          throw new Error("init boom")
        }),
    })

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "healthy-after-init-failure" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor: healthy },
      },
      {
        manifest: { id: "broken-on-init" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor: broken },
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const changed = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(changed).toBe(true)
      expect(snapshots.map((snapshot) => snapshot.extensionId)).toEqual([
        "healthy-after-init-failure",
      ])
      expect(statuses).toEqual([
        {
          extensionId: "healthy-after-init-failure",
          sessionId,
          branchId,
          status: "running",
        },
        {
          extensionId: "broken-on-init",
          sessionId,
          branchId,
          status: "failed",
          error: "Error: init boom",
          failurePhase: "start",
        },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.live("publish failure restarts once and retries", () => {
    let first = true
    const flaky = reducerActor({
      id: "flaky-publisher",
      initial: { count: 0 },
      stateSchema: Schema.Struct({ count: Schema.Number }),
      reduce: (state) => {
        if (first) {
          first = false
          throw new Error("publish boom")
        }
        return { state: { count: state.count + 1 } }
      },
      derive: (state) => ({ uiModel: state }),
    })

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "flaky-publisher" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor: flaky },
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const changed = yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(changed).toBe(true)
      expect(snapshots[0]?.model).toEqual({ count: 1 })
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

  it.live("send failure restarts once and retries", () => {
    const Ping = ExtensionMessage("flaky-command", "Ping", {})
    let first = true
    const flaky = reducerActor<{ count: number }, ReturnType<typeof Ping>>({
      id: "flaky-command",
      initial: { count: 0 },
      stateSchema: Schema.Struct({ count: Schema.Number }),
      reduce: (state) => ({ state }),
      receive: (state) => {
        if (first) {
          first = false
          throw new Error("command boom")
        }
        return { state: { count: state.count + 1 } }
      },
      derive: (state) => ({ uiModel: state }),
    })

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "flaky-command" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor: flaky, protocols: [Ping] },
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      yield* runtime.send(sessionId, Ping({}), branchId)
      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(snapshots[0]?.model).toEqual({ count: 1 })
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

  it.live("ask failure restarts once and retries", () => {
    const Ping = ExtensionMessage.reply(
      "flaky-request",
      "Ping",
      {},
      Schema.Struct({ count: Schema.Number }),
    )
    let first = true
    const flaky = reducerActor<{ count: number }, never, ReturnType<typeof Ping>>({
      id: "flaky-request",
      initial: { count: 0 },
      stateSchema: Schema.Struct({ count: Schema.Number }),
      reduce: (state) => ({ state }),
      request: (state) => {
        if (first) {
          first = false
          throw new Error("reply boom")
        }
        return Effect.succeed({
          state: { count: state.count + 1 },
          reply: { count: state.count + 1 },
        })
      },
      derive: (state) => ({ uiModel: state }),
    })

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "flaky-request" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: { actor: flaky, protocols: [Ping] },
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* ExtensionStateRuntime
      const reply = yield* runtime.ask(sessionId, Ping({}), branchId)
      const statuses = yield* runtime.getActorStatuses(sessionId)

      expect(reply).toEqual({ count: 1 })
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

  it.live("invalid replies are rejected against the registered protocol", () => {
    const GetCount = ExtensionMessage.reply(
      "counter",
      "GetCount",
      {},
      Schema.Struct({ count: Schema.Number }),
    )

    const layer = makeRuntimeLayer([
      {
        manifest: { id: "counter" },
        kind: "builtin",
        sourcePath: "builtin",
        setup: {
          actor: reducerActor<{ count: number }, never, ReturnType<typeof GetCount>>({
            id: "counter",
            initial: { count: 0 },
            stateSchema: Schema.Struct({ count: Schema.Number }),
            reduce: (state) => ({ state }),
            request: (state) =>
              Effect.succeed({
                state,
                reply: { count: "not-a-number" } as unknown,
              }),
          }),
          protocols: [GetCount],
        },
      },
    ])

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
        }
      }
    }).pipe(Effect.provide(layer))
  })
})
