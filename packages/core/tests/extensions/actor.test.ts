import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Ref, Schema } from "effect"
import { ExtensionMessage, ExtensionProtocolError } from "@gent/core/domain/extension-protocol"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import {
  BaseEventStore,
  EventStore,
  SessionStarted,
  TaskCompleted,
  TurnCompleted,
} from "@gent/core/domain/event"
import type { AgentEvent, EventStoreService } from "@gent/core/domain/event"
import { BranchId, SessionId, TaskId } from "@gent/core/domain/ids"
import type { LoadedExtension, ReduceResult } from "@gent/core/domain/extension"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"
import { spawnMachineExtensionRef } from "@gent/core/runtime/extensions/spawn-machine-ref"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { workflow as workflowContribution } from "@gent/core/domain/contribution"
import { reducerActor } from "./helpers/reducer-actor"
import { makeActorRuntimeLayer } from "./helpers/actor-runtime-layer"

// ============================================================================
// Shared fixtures
// ============================================================================

const sessionId = SessionId.of("test-session")
const branchId = BranchId.of("test-branch")
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

const makeCounterExtension = (id: string): LoadedExtension => ({
  manifest: { id },
  kind: "builtin",
  sourcePath: "builtin",
  contributions: [workflowContribution(makeCounterActor(id))],
})

const makeRuntimeLayer = (extensions: LoadedExtension[]) => makeActorRuntimeLayer({ extensions })

// ============================================================================
// spawnMachineExtensionRef — actor boundary
// ============================================================================

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

// ============================================================================
// WorkflowRuntime — supervisor behavior
// ============================================================================

describe("WorkflowRuntime", () => {
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
        contributions: [workflowContribution(healthy)],
      },
      {
        manifest: { id: "broken-actor" },
        kind: "builtin",
        sourcePath: "builtin",
        contributions: [workflowContribution(broken)],
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
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
        contributions: [workflowContribution(healthy)],
      },
      {
        manifest: { id: "broken-on-init" },
        kind: "builtin",
        sourcePath: "builtin",
        contributions: [workflowContribution(broken)],
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
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
        contributions: [workflowContribution(flaky)],
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
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
        contributions: [workflowContribution({ ...flaky, protocols: { Ping } })],
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
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
        contributions: [workflowContribution({ ...flaky, protocols: { Ping } })],
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
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
        contributions: [
          workflowContribution({
            ...reducerActor<{ count: number }, never, ReturnType<typeof GetCount>>({
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
            protocols: { GetCount },
          }),
        ],
      },
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
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

  it.live("multiple extensions receive same event", () => {
    const layer = makeRuntimeLayer([
      makeCounterExtension("counter-a"),
      makeCounterExtension("counter-b"),
    ])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })

      const snapshots = yield* runtime.getUiSnapshots(sessionId, branchId)
      expect(snapshots.length).toBe(2)

      const a = snapshots.find((s) => s.extensionId === "counter-a")
      const b = snapshots.find((s) => s.extensionId === "counter-b")
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      expect((a!.model as { count: number }).count).toBe(1)
      expect((b!.model as { count: number }).count).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.live("terminated actor restarts fresh on next event", () => {
    const layer = makeRuntimeLayer([makeCounterExtension("ephemeral")])

    return Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime

      yield* runtime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId,
      })
      const snap1 = yield* runtime.getUiSnapshots(sessionId, branchId)
      expect(snap1.length).toBe(1)

      yield* runtime.terminateAll(sessionId)

      yield* runtime.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }), {
        sessionId,
        branchId,
      })
      const snap2 = yield* runtime.getUiSnapshots(sessionId, branchId)
      expect((snap2[0]!.model as { count: number }).count).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

// ============================================================================
// EventPublisher — event routing
// ============================================================================

describe("event routing", () => {
  interface RecorderState {
    readonly seen: ReadonlyArray<string>
  }

  const RecorderSchema = Schema.Struct({ seen: Schema.Array(Schema.String) })

  const recorderReducer = reducerActor<RecorderState>({
    id: "test-recorder",
    initial: { seen: [] },
    stateSchema: RecorderSchema,
    uiModelSchema: RecorderSchema,
    reduce: (state, event): ReduceResult<RecorderState> => ({
      state: { seen: [...state.seen, event._tag] },
    }),
    derive: (state) => ({ uiModel: state }),
  })

  const recorderExtension: LoadedExtension = {
    manifest: { id: "test-recorder" },
    kind: "builtin",
    sourcePath: "builtin",
    contributions: [workflowContribution(recorderReducer)],
  }

  interface SnapshotCounterState {
    readonly snapshotsSeen: number
  }

  const SnapshotCounterSchema = Schema.Struct({ snapshotsSeen: Schema.Number })

  const snapshotCounterReducer = reducerActor<SnapshotCounterState>({
    id: "snapshot-counter",
    initial: { snapshotsSeen: 0 },
    stateSchema: SnapshotCounterSchema,
    uiModelSchema: SnapshotCounterSchema,
    reduce: (state, event): ReduceResult<SnapshotCounterState> => {
      if (event._tag === "ExtensionUiSnapshot") {
        return { state: { snapshotsSeen: state.snapshotsSeen + 1 } }
      }
      if (event._tag === "TurnCompleted") {
        return { state: { snapshotsSeen: state.snapshotsSeen } }
      }
      return { state }
    },
    derive: (state) => ({ uiModel: state }),
  })

  const snapshotCounterExtension: LoadedExtension = {
    manifest: { id: "snapshot-counter" },
    kind: "builtin",
    sourcePath: "builtin",
    contributions: [workflowContribution(snapshotCounterReducer)],
  }

  const makeRoutingLayer = (extensions: LoadedExtension[]) => {
    const published = Effect.runSync(Ref.make<AgentEvent[]>([]))
    const stateRuntimeLayer = WorkflowRuntime.Live(extensions).pipe(
      Layer.provideMerge(ExtensionTurnControl.Test()),
    )
    const baseService: EventStoreService = {
      publish: (event) => Ref.update(published, (events) => [...events, event]).pipe(Effect.asVoid),
      subscribe: () => Effect.void as never,
      removeSession: () => Effect.void,
    }
    const baseLayer = Layer.merge(
      Layer.succeed(BaseEventStore, baseService),
      Layer.succeed(EventStore, baseService),
    )
    const servicesLayer = Storage.Test()
    const registryLayer = ExtensionRegistry.fromResolved(resolveExtensions(extensions))
    const combinedBase = Layer.mergeAll(
      baseLayer,
      stateRuntimeLayer,
      servicesLayer,
      registryLayer,
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, combinedBase)
    const fullLayer = Layer.mergeAll(combinedBase, eventPublisherLayer)
    return { published, fullLayer }
  }

  it.live("events reach extension reduce — recorder sees every event _tag", () => {
    const { fullLayer } = makeRoutingLayer([recorderExtension])

    return Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      const stateRuntime = yield* WorkflowRuntime

      yield* eventPublisher.publish(new SessionStarted({ sessionId, branchId }))
      yield* eventPublisher.publish(
        new TaskCompleted({ sessionId, branchId, taskId: TaskId.of("t-1") }),
      )
      yield* eventPublisher.publish(new TurnCompleted({ sessionId, branchId, durationMs: 100 }))

      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const recorderSnapshot = snapshots.find((s) => s.extensionId === "test-recorder")
      expect(recorderSnapshot).toBeDefined()
      const model = recorderSnapshot!.model as RecorderState

      expect(model.seen).toContain("SessionStarted")
      expect(model.seen).toContain("TaskCompleted")
      expect(model.seen).toContain("TurnCompleted")
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("UI snapshots are published when state changes", () => {
    const { published, fullLayer } = makeRoutingLayer([recorderExtension])

    return Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      yield* eventPublisher.publish(new SessionStarted({ sessionId, branchId }))

      const events = yield* Ref.get(published)
      const snapshots = events.filter((e) => e._tag === "ExtensionUiSnapshot")
      expect(snapshots.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("ExtensionUiSnapshot does not recurse", () => {
    const { published, fullLayer } = makeRoutingLayer([snapshotCounterExtension])

    return Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      const stateRuntime = yield* WorkflowRuntime

      yield* eventPublisher.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }))

      const events = yield* Ref.get(published)
      const snapshotCount = events.filter((e) => e._tag === "ExtensionUiSnapshot").length

      const actorSnapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const counter = actorSnapshots.find((s) => s.extensionId === "snapshot-counter")
      expect(counter).toBeDefined()
      const model = counter!.model as SnapshotCounterState
      expect(model.snapshotsSeen).toBe(0)
      expect(snapshotCount).toBe(1)
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("invalid uiModel is dropped when schema validation fails", () => {
    const strictSchema = Schema.Struct({ count: Schema.Number, label: Schema.String })
    const badModelActor = reducerActor({
      id: "bad-model",
      initial: { count: 0 },
      reduce: (state: { count: number }, event): ReduceResult<{ count: number }> => {
        if (event._tag === "TurnCompleted") return { state: { count: state.count + 1 } }
        return { state }
      },
      derive: (state: { count: number }) => ({ uiModel: { count: state.count } }),
      uiModelSchema: strictSchema,
    })

    const badModelExtension: LoadedExtension = {
      manifest: { id: "bad-model" },
      kind: "builtin",
      sourcePath: "test",
      contributions: [workflowContribution(badModelActor)],
    }

    const { fullLayer } = makeRoutingLayer([badModelExtension])

    return Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      const stateRuntime = yield* WorkflowRuntime

      yield* eventPublisher.publish(new TurnCompleted({ sessionId, branchId, durationMs: 50 }))

      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const badSnapshot = snapshots.find((s) => s.extensionId === "bad-model")
      expect(badSnapshot).toBeUndefined()
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("valid uiModel passes schema validation and appears in snapshots", () => {
    const { fullLayer } = makeRoutingLayer([recorderExtension])

    return Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      const stateRuntime = yield* WorkflowRuntime

      yield* eventPublisher.publish(new SessionStarted({ sessionId, branchId }))

      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const recorder = snapshots.find((s) => s.extensionId === "test-recorder")
      expect(recorder).toBeDefined()
      expect((recorder!.model as RecorderState).seen).toContain("SessionStarted")
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("crashing derive is isolated from other extensions", () => {
    const crashingDerive = reducerActor({
      id: "crashing-derive",
      initial: { value: 0 },
      reduce: (state: { value: number }) => ({ state: { value: state.value + 1 } }),
      derive: (state: { value: number }, ctx?) => {
        if (ctx === undefined) throw new Error("ctx.agent required")
        return { uiModel: { value: state.value } }
      },
    })
    const crashingExtension: LoadedExtension = {
      manifest: { id: "crashing-derive" },
      kind: "builtin",
      sourcePath: "test",
      contributions: [workflowContribution(crashingDerive)],
    }
    const { fullLayer } = makeRoutingLayer([recorderExtension, crashingExtension])

    return Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      const stateRuntime = yield* WorkflowRuntime

      yield* eventPublisher.publish(new SessionStarted({ sessionId, branchId }))

      const snapshots = yield* stateRuntime.getUiSnapshots(sessionId, branchId)
      const recorder = snapshots.find((s) => s.extensionId === "test-recorder")
      expect(recorder).toBeDefined()
      const crashing = snapshots.find((s) => s.extensionId === "crashing-derive")
      expect(crashing).toBeUndefined()
    }).pipe(Effect.provide(fullLayer))
  })

  it.live("events without branchId skip snapshot publication but still reduce", () => {
    const { fullLayer } = makeRoutingLayer([recorderExtension])

    return Effect.gen(function* () {
      const stateRuntime = yield* WorkflowRuntime

      const changed = yield* stateRuntime.publish(new SessionStarted({ sessionId, branchId }), {
        sessionId,
        branchId: undefined,
      })
      expect(changed).toBe(true)
    }).pipe(Effect.provide(fullLayer))
  })
})
