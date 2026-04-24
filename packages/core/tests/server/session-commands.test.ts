import { describe, it, expect } from "effect-bun-test"
import { Cause, Context, Deferred, Effect, Layer, Logger, Option, Stream } from "effect"
import { createSequenceProvider, createSignalProvider, textStep } from "@gent/core/debug/provider"
import { ModelId } from "@gent/core/domain/model"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { Branch, Message, Session, TextPart } from "@gent/core/domain/message"
import { emptyQueueSnapshot } from "@gent/core/domain/queue"
import { EventStore, EventStoreError, SessionStarted } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import type { ProjectionContribution } from "@gent/core/domain/projection"
import { Provider } from "@gent/core/providers/provider"
import {
  SessionRuntime,
  SessionRuntimeError,
  SessionRuntimeStateSchema,
} from "../../src/runtime/session-runtime"
import {
  MachineEngine,
  type MachineEngineService,
} from "../../src/runtime/extensions/resource-host/machine-engine"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { SessionProfileCache, type SessionProfile } from "../../src/runtime/session-profile"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { SessionCommands } from "../../src/server/session-commands"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"
import { Storage, StorageError, subTagLayers } from "@gent/core/storage/sqlite-storage"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../extensions/helpers/test-preset"
import type { LoadedExtension } from "../../src/domain/extension"
import { SessionMutations } from "../../src/domain/session-mutations"

const makeClient = (reply = "ok") =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* createSequenceProvider([textStep(reply)])
    return yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
  })

const collectSessionEvents = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()

    yield* stream.pipe(
      Stream.runForEach(() => Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
      Effect.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.ignore)),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    return closed
  })

const failingPublisherLayer = Layer.succeed(EventPublisher, {
  append: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
  deliver: () => Effect.void,
  publish: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
  terminateSession: () => Effect.void,
})

const failingSessionCommandsLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    SessionRuntime.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    EventStore.Memory,
    failingPublisherLayer,
    Provider.Debug(),
    MachineEngine.Test(),
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const postCommitFailingSessionCommandsLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const eventStoreLayer = EventStore.Memory
  const postCommitFailingPublisherLayer = Layer.effect(
    EventPublisher,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      return EventPublisher.of({
        append: (event) => eventStore.append(event),
        deliver: () => Effect.fail(new EventStoreError({ message: "deliver failed" })),
        publish: (event) =>
          Effect.gen(function* () {
            const envelope = yield* eventStore.append(event)
            yield* Effect.fail(new EventStoreError({ message: "deliver failed" }))
            return envelope
          }),
        terminateSession: () => Effect.void,
      })
    }),
  ).pipe(Layer.provide(eventStoreLayer))
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    SessionRuntime.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    eventStoreLayer,
    postCommitFailingPublisherLayer,
    Provider.Debug(),
    MachineEngine.Test(),
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const createActiveSessionFixture = Effect.fn("createActiveSessionFixture")(function* (input: {
  readonly sessions: SessionStorage
  readonly branches: BranchStorage
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly now: Date
  readonly name?: string
}) {
  const session = new Session({
    id: input.sessionId,
    name: input.name,
    createdAt: input.now,
    updatedAt: input.now,
  })
  yield* input.sessions.createSession(session)
  yield* input.branches.createBranch(
    new Branch({ id: input.branchId, sessionId: input.sessionId, createdAt: input.now }),
  )
  yield* input.sessions.updateSession(new Session({ ...session, activeBranchId: input.branchId }))
})

const sendFailingSessionCommandsLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const failingRuntimeLayer = Layer.succeed(SessionRuntime, {
    dispatch: () => Effect.fail(new SessionRuntimeError({ message: "runtime failed" })),
    runPrompt: () => Effect.void,
    drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getState: () =>
      Effect.succeed(
        SessionRuntimeStateSchema.Idle.make({
          agent: "cowork" as const,
          queue: emptyQueueSnapshot(),
        }),
      ),
    getMetrics: () =>
      Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
    watchState: () => Effect.succeed(Stream.empty),
    terminateSession: () => Effect.void,
    restoreSession: () => Effect.void,
  })
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    failingRuntimeLayer,
    SessionCommands.SessionRuntimeTerminatorLive,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    MachineEngine.Test(),
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const sessionCommandsLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    SessionRuntime.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    MachineEngine.Test(),
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const sessionRuntimeProbeLayer = (terminated: Array<SessionId>, restored?: Array<SessionId>) =>
  Layer.succeed(SessionRuntime, {
    dispatch: () => Effect.void,
    runPrompt: () => Effect.void,
    drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getState: () =>
      Effect.succeed(
        SessionRuntimeStateSchema.Idle.make({
          agent: "cowork" as const,
          queue: emptyQueueSnapshot(),
        }),
      ),
    getMetrics: () =>
      Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
    watchState: () => Effect.succeed(Stream.empty),
    terminateSession: (sessionId) =>
      Effect.sync(() => {
        terminated.push(sessionId)
      }),
    restoreSession: (sessionId) =>
      Effect.sync(() => {
        restored?.push(sessionId)
      }),
  })

const sessionCommandsLayerWithMachineProbe = (
  terminated: Array<SessionId>,
  runtimeTerminated?: Array<SessionId>,
  runtimeRestored?: Array<SessionId>,
) => {
  const storageLayer = Storage.MemoryWithSql()
  const machineProbeLayer = Layer.succeed(MachineEngine, {
    publish: () => Effect.succeed([]),
    send: () => Effect.void,
    execute: () => Effect.die("unexpected machine request"),
    getActorStatuses: () => Effect.succeed([]),
    terminateAll: (sessionId) =>
      Effect.sync(() => {
        terminated.push(sessionId)
      }),
  } satisfies MachineEngineService)
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    runtimeTerminated === undefined
      ? SessionRuntime.Test()
      : sessionRuntimeProbeLayer(runtimeTerminated, runtimeRestored),
    SessionCommands.SessionRuntimeTerminatorLive,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    machineProbeLayer,
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const sessionMutationsLayerWithMachineProbe = (
  terminated: Array<SessionId>,
  runtimeTerminated: Array<SessionId>,
) => {
  const storageLayer = Storage.MemoryWithSql()
  const runtimeLayer = sessionRuntimeProbeLayer(runtimeTerminated)
  const machineProbeLayer = Layer.succeed(MachineEngine, {
    publish: () => Effect.succeed([]),
    send: () => Effect.void,
    execute: () => Effect.die("unexpected machine request"),
    getActorStatuses: () => Effect.succeed([]),
    terminateAll: (sessionId) =>
      Effect.sync(() => {
        terminated.push(sessionId)
      }),
  } satisfies MachineEngineService)
  const terminatorRegistrationLayer = Layer.provide(
    SessionCommands.RegisterSessionRuntimeTerminatorLive,
    Layer.mergeAll(runtimeLayer, SessionCommands.SessionRuntimeTerminatorLive),
  )
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    runtimeLayer,
    SessionCommands.SessionRuntimeTerminatorLive,
    terminatorRegistrationLayer,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    machineProbeLayer,
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.SessionMutationsLive, deps)
}

const failingDeleteSessionCommandsLayerWithMachineProbe = (
  terminated: Array<SessionId>,
  runtimeTerminated: Array<SessionId>,
  runtimeRestored: Array<SessionId>,
) => {
  const storageLayer = Storage.MemoryWithSql()
  const baseSessionStorage = subTagLayers(storageLayer)
  const failingSessionStorageLayer = Layer.effect(
    SessionStorage,
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      return {
        ...sessions,
        deleteSession: () => Effect.fail(new StorageError({ message: "delete failed" })),
      }
    }),
  ).pipe(Layer.provide(baseSessionStorage))
  const machineProbeLayer = Layer.succeed(MachineEngine, {
    publish: () => Effect.succeed([]),
    send: () => Effect.void,
    execute: () => Effect.die("unexpected machine request"),
    getActorStatuses: () => Effect.succeed([]),
    terminateAll: (sessionId) =>
      Effect.sync(() => {
        terminated.push(sessionId)
      }),
  } satisfies MachineEngineService)
  const deps = Layer.mergeAll(
    storageLayer,
    baseSessionStorage,
    failingSessionStorageLayer,
    sessionRuntimeProbeLayer(runtimeTerminated, runtimeRestored),
    SessionCommands.SessionRuntimeTerminatorLive,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    machineProbeLayer,
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const makeMachineProbe = (terminated: Array<SessionId>): MachineEngineService => ({
  publish: () => Effect.succeed([]),
  send: () => Effect.void,
  execute: () => Effect.die("unexpected machine request"),
  getActorStatuses: () => Effect.succeed([]),
  terminateAll: (sessionId) =>
    Effect.sync(() => {
      terminated.push(sessionId)
    }),
})

const makeProfile = (cwd: string, machine: MachineEngineService): SessionProfile => {
  const resolved = resolveExtensions([])
  const layerContext = Effect.runSync(
    Layer.build(
      Layer.mergeAll(
        ExtensionRegistry.fromResolved(resolved),
        DriverRegistry.fromResolved({
          modelDrivers: resolved.modelDrivers,
          externalDrivers: resolved.externalDrivers,
        }),
        Layer.succeed(MachineEngine, machine),
      ),
    ).pipe(Effect.scoped),
  )

  return {
    cwd,
    extensions: [],
    resolved,
    layerContext,
    permissionService: {
      check: () => Effect.succeed("allowed"),
      addRule: () => Effect.void,
      removeRule: () => Effect.void,
      getRules: () => Effect.succeed([]),
    },
    registryService: Context.get(layerContext, ExtensionRegistry),
    driverRegistryService: Context.get(layerContext, DriverRegistry),
    extensionStateRuntime: Context.get(layerContext, MachineEngine),
    subscriptionEngine: undefined,
    baseSections: [],
    instructions: "",
  }
}

const sessionCommandsLayerWithProfileMachineProbes = (params: {
  readonly primaryTerminated: Array<SessionId>
  readonly profileTerminated: Map<string, Array<SessionId>>
}) => {
  const storageLayer = Storage.MemoryWithSql()
  const primaryMachineLayer = Layer.succeed(
    MachineEngine,
    makeMachineProbe(params.primaryTerminated),
  )
  const profileCacheLayer = SessionProfileCache.Test(
    new Map(
      [...params.profileTerminated].map(([cwd, terminated]) => [
        cwd,
        makeProfile(cwd, makeMachineProbe(terminated)),
      ]),
    ),
  )
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    SessionRuntime.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    primaryMachineLayer,
    profileCacheLayer,
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const parentToolCallProbeProjection: ProjectionContribution<string | undefined> = {
  id: "parent-tool-call-probe",
  query: (ctx) => Effect.succeed(ctx.turn.parentToolCallId),
  prompt: (parentToolCallId) =>
    parentToolCallId === undefined
      ? []
      : [
          {
            id: "parent-tool-call-probe",
            content: `parentToolCallId:${parentToolCallId}`,
            priority: 45,
          },
        ],
}

const parentToolCallProbeExtension: LoadedExtension = {
  manifest: { id: "parent-tool-call-probe" },
  scope: "builtin",
  sourcePath: "test",
  contributions: { projections: [parentToolCallProbeProjection] },
}

describe("session command persistence", () => {
  it.live("sendMessage surfaces runtime failure and does not log message sent", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const logMessages: string[] = []
      const captureLogger = Logger.make(({ message }) => {
        logMessages.push(
          Array.isArray(message)
            ? message.map((entry) => String(entry)).join(" ")
            : String(message),
        )
      })

      const exit = yield* Effect.exit(
        commands
          .sendMessage({
            sessionId: SessionId.make("send-runtime-failure"),
            branchId: BranchId.make("send-runtime-failure-branch"),
            content: "fail loudly",
          })
          .pipe(Effect.provide(Logger.layer([captureLogger]))),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(SessionRuntimeError)
          expect(error.value.message).toBe("runtime failed")
        }
      }
      expect(logMessages).not.toContain("session.messageSent")
    }).pipe(Effect.provide(sendFailingSessionCommandsLayer())),
  )

  it.live("rolls back session and branch creation when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage

      const exit = yield* Effect.exit(commands.createSession({ cwd: "/tmp/rollback" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(0)
      expect(yield* branches.listBranches(SessionId.make("missing"))).toHaveLength(0)
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back forked branch and copied messages when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-rollback")
      const branchId = BranchId.make("branch-source")
      const messageId = MessageId.make("message-source")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "rollback",
      })
      yield* messages.createMessage(
        Message.Regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [new TextPart({ type: "text", text: "seed" })],
          createdAt: now,
        }),
      )

      const exit = yield* Effect.exit(
        commands.forkBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "fork",
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.listBranches(sessionId)).toHaveLength(1)
      expect(yield* messages.listMessages(branchId)).toHaveLength(1)
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back session rename when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-rename-rollback")
      const branchId = BranchId.make("branch-rename-rollback")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "before",
      })

      const exit = yield* Effect.exit(commands.renameSession({ sessionId, name: "after" }))

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.name).toBe("before")
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back active branch switch when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-rollback")
      const fromBranchId = BranchId.make("branch-switch-from")
      const toBranchId = BranchId.make("branch-switch-to")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
        name: "switch",
      })
      yield* branches.createBranch(new Branch({ id: toBranchId, sessionId, createdAt: now }))

      const exit = yield* Effect.exit(
        commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          summarize: false,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rejects active branch switch to a branch outside the session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-owner")
      const otherSessionId = SessionId.make("session-switch-other")
      const fromBranchId = BranchId.make("branch-switch-owner-from")
      const toBranchId = BranchId.make("branch-switch-owner-foreign")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
        name: "switch owner",
      })
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: otherSessionId,
        branchId: toBranchId,
        now,
        name: "other",
      })

      const exit = yield* Effect.exit(
        commands.switchActiveBranch({
          sessionId,
          fromBranchId,
          toBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back reasoning setting when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-settings-rollback")
      const branchId = BranchId.make("branch-settings-rollback")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "settings",
      })

      const exit = yield* Effect.exit(
        commands.updateSessionReasoningLevel({ sessionId, reasoningLevel: "high" }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.reasoningLevel).toBeUndefined()
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("does not roll back committed rows when post-commit delivery fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage

      const exit = yield* Effect.exit(commands.createSession({ cwd: "/tmp/post-commit" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(1)
    }).pipe(Effect.provide(postCommitFailingSessionCommandsLayer())),
  )

  it.live("deletes only non-active branches owned by the session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-branch")
      const activeBranchId = BranchId.make("branch-delete-active")
      const deletedBranchId = BranchId.make("branch-delete-target")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete branch",
      })
      yield* branches.createBranch(new Branch({ id: deletedBranchId, sessionId, createdAt: now }))

      yield* commands.deleteBranch({
        sessionId,
        currentBranchId: activeBranchId,
        branchId: deletedBranchId,
      })

      expect(yield* branches.getBranch(deletedBranchId)).toBeUndefined()
      expect(yield* branches.getBranch(activeBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.live("rejects session creation with parent branch but no parent session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage

      const exit = yield* Effect.exit(
        commands.createSession({
          parentBranchId: BranchId.make("dangling-parent-branch"),
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(0)
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.live("rejects deleting a branch with child branches", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-parent-branch")
      const activeBranchId = BranchId.make("branch-delete-parent-active")
      const parentBranchId = BranchId.make("branch-delete-parent")
      const childBranchId = BranchId.make("branch-delete-child")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete parent branch",
      })
      yield* branches.createBranch(new Branch({ id: parentBranchId, sessionId, createdAt: now }))
      yield* branches.createBranch(
        new Branch({
          id: childBranchId,
          sessionId,
          parentBranchId,
          createdAt: now,
        }),
      )

      const exit = yield* Effect.exit(
        commands.deleteBranch({
          sessionId,
          currentBranchId: activeBranchId,
          branchId: parentBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.getBranch(parentBranchId)).toBeDefined()
      expect(yield* branches.getBranch(childBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.live("rejects deleting a branch with child sessions", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-child-session-parent")
      const activeBranchId = BranchId.make("branch-delete-child-session-active")
      const parentBranchId = BranchId.make("branch-delete-child-session-parent")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete child session parent",
      })
      yield* branches.createBranch(new Branch({ id: parentBranchId, sessionId, createdAt: now }))
      const child = yield* commands.createChildSession({
        parentSessionId: sessionId,
        parentBranchId,
        name: "child",
      })

      const exit = yield* Effect.exit(
        commands.deleteBranch({
          sessionId,
          currentBranchId: activeBranchId,
          branchId: parentBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.getBranch(parentBranchId)).toBeDefined()
      expect(yield* sessions.getSession(child.sessionId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.live("rejects deleting the active branch even when it is not the caller branch", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-delete-active")
      const activeBranchId = BranchId.make("branch-active-delete")
      const currentBranchId = BranchId.make("branch-current-delete")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: activeBranchId,
        now,
        name: "delete active",
      })
      yield* branches.createBranch(new Branch({ id: currentBranchId, sessionId, createdAt: now }))

      const exit = yield* Effect.exit(
        commands.deleteBranch({
          sessionId,
          currentBranchId,
          branchId: activeBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.getBranch(activeBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.live("rejects destructive branch mutation across sessions", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const ownerSessionId = SessionId.make("session-delete-owner")
      const otherSessionId = SessionId.make("session-delete-other")
      const currentBranchId = BranchId.make("branch-delete-owner-current")
      const otherBranchId = BranchId.make("branch-delete-other-target")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: ownerSessionId,
        branchId: currentBranchId,
        now,
        name: "owner",
      })
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: otherSessionId,
        branchId: otherBranchId,
        now,
        name: "other",
      })

      const exit = yield* Effect.exit(
        commands.deleteBranch({
          sessionId: ownerSessionId,
          currentBranchId,
          branchId: otherBranchId,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.getBranch(otherBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.live("deleteMessages only mutates branches owned by the session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-delete-messages")
      const branchId = BranchId.make("branch-delete-messages")
      const firstMessageId = MessageId.make("message-delete-1")
      const secondMessageId = MessageId.make("message-delete-2")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "delete messages",
      })
      yield* messages.createMessage(
        Message.Regular.make({
          id: firstMessageId,
          sessionId,
          branchId,
          role: "user",
          parts: [new TextPart({ type: "text", text: "first" })],
          createdAt: now,
        }),
      )
      yield* messages.createMessage(
        Message.Regular.make({
          id: secondMessageId,
          sessionId,
          branchId,
          role: "assistant",
          parts: [new TextPart({ type: "text", text: "second" })],
          createdAt: new Date(now.getTime() + 1),
        }),
      )

      yield* commands.deleteMessages({ sessionId, branchId, afterMessageId: firstMessageId })

      const remaining = yield* messages.listMessages(branchId)
      expect(remaining.map((message) => message.id)).toEqual([firstMessageId])
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )

  it.live("deleteMessages rejects a cursor from another session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-delete-messages-owner")
      const branchId = BranchId.make("branch-delete-messages-owner")
      const otherSessionId = SessionId.make("session-delete-messages-other")
      const otherBranchId = BranchId.make("branch-delete-messages-other")
      const foreignMessageId = MessageId.make("message-delete-foreign")
      const ownerMessageId = MessageId.make("message-delete-owner")
      const now = new Date()

      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
        name: "owner",
      })
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId: otherSessionId,
        branchId: otherBranchId,
        now,
        name: "other",
      })
      yield* messages.createMessage(
        Message.Regular.make({
          id: foreignMessageId,
          sessionId: otherSessionId,
          branchId: otherBranchId,
          role: "user",
          parts: [new TextPart({ type: "text", text: "foreign" })],
          createdAt: now,
        }),
      )
      yield* messages.createMessage(
        Message.Regular.make({
          id: ownerMessageId,
          sessionId,
          branchId,
          role: "assistant",
          parts: [new TextPart({ type: "text", text: "owner" })],
          createdAt: new Date(now.getTime() + 1),
        }),
      )

      const exit = yield* Effect.exit(
        commands.deleteMessages({ sessionId, branchId, afterMessageId: foreignMessageId }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* messages.listMessages(branchId)).map((message) => message.id)).toEqual([
        ownerMessageId,
      ])
    }).pipe(Effect.provide(sessionCommandsLayer())),
  )
})

describe("session.delete", () => {
  it.live("closes session event streams and removes the session from public queries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })
        const closed = yield* collectSessionEvents(
          client.session.events({
            sessionId: created.sessionId,
          }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))

        const deleted = yield* client.session.get({ sessionId: created.sessionId })
        const sessions = yield* client.session.list()

        expect(deleted).toBeNull()
        expect(sessions.some((session) => session.id === created.sessionId)).toBe(false)
      }),
    ),
  )

  it.live("closes descendant event streams and removes descendants on public delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const parent = yield* client.session.create({ cwd: process.cwd() })
        const child = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
        })
        const grandchild = yield* client.session.create({
          cwd: process.cwd(),
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
        })

        const parentClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: parent.sessionId }),
        )
        const childClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: child.sessionId }),
        )
        const grandchildClosed = yield* collectSessionEvents(
          client.session.events({ sessionId: grandchild.sessionId }),
        )

        yield* client.session.delete({ sessionId: parent.sessionId })

        yield* Deferred.await(parentClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(childClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(grandchildClosed).pipe(Effect.timeout("5 seconds"))

        expect(yield* client.session.get({ sessionId: parent.sessionId })).toBeNull()
        expect(yield* client.session.get({ sessionId: child.sessionId })).toBeNull()
        expect(yield* client.session.get({ sessionId: grandchild.sessionId })).toBeNull()
      }),
    ),
  )

  it.live("closes runtime streams and interrupts active loops on public delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* createSignalProvider("delete me later")
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })
        const runtimeClosed = yield* collectSessionEvents(
          client.session.watchRuntime({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
        )

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "start an active loop before delete",
        })
        yield* controls.waitForStreamStart.pipe(Effect.timeout("5 seconds"))

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(runtimeClosed).pipe(Effect.timeout("5 seconds"))

        expect(yield* client.session.get({ sessionId: created.sessionId })).toBeNull()
      }),
    ),
  )

  it.live("is idempotent when deleting an already deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* client.session.delete({ sessionId: created.sessionId })
        const deleted = yield* client.session.get({ sessionId: created.sessionId })

        expect(deleted).toBeNull()
      }),
    ),
  )

  it.live("cleans runtime state for descendant sessions before durable cascade", () => {
    const terminated: Array<SessionId> = []
    const runtimeTerminated: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const eventStore = yield* EventStore
        const cwdRegistry = yield* SessionCwdRegistry

        const parent = yield* commands.createSession({ cwd: "/tmp/delete-parent" })
        const child = yield* commands.createChildSession({
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          cwd: "/tmp/delete-child",
        })
        const grandchild = yield* commands.createChildSession({
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
          cwd: "/tmp/delete-grandchild",
        })

        const primeSessionStream = Effect.fn("primeSessionStream")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const closed = collectSessionEvents(eventStore.subscribe({ sessionId }))
          yield* eventStore.publish(SessionStarted.make({ sessionId, branchId }))
          return yield* closed
        })

        const parentClosed = yield* primeSessionStream(parent.sessionId, parent.branchId)
        const childClosed = yield* primeSessionStream(child.sessionId, child.branchId)
        const grandchildClosed = yield* primeSessionStream(
          grandchild.sessionId,
          grandchild.branchId,
        )

        expect(yield* cwdRegistry.lookup(parent.sessionId)).toBe("/tmp/delete-parent")
        expect(yield* cwdRegistry.lookup(child.sessionId)).toBe("/tmp/delete-child")
        expect(yield* cwdRegistry.lookup(grandchild.sessionId)).toBe("/tmp/delete-grandchild")

        yield* commands.deleteSession(parent.sessionId)

        yield* Deferred.await(parentClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(childClosed).pipe(Effect.timeout("5 seconds"))
        yield* Deferred.await(grandchildClosed).pipe(Effect.timeout("5 seconds"))
        expect(yield* cwdRegistry.lookup(parent.sessionId)).toBeUndefined()
        expect(yield* cwdRegistry.lookup(child.sessionId)).toBeUndefined()
        expect(yield* cwdRegistry.lookup(grandchild.sessionId)).toBeUndefined()
        expect(runtimeTerminated).toEqual([parent.sessionId, child.sessionId, grandchild.sessionId])
        expect(terminated).toEqual([parent.sessionId, child.sessionId, grandchild.sessionId])
      }).pipe(Effect.provide(sessionCommandsLayerWithMachineProbe(terminated, runtimeTerminated))),
    )
  })

  it.live("cleans runtime state for mutation deletes used by extension hosts", () => {
    const terminated: Array<SessionId> = []
    const runtimeTerminated: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const now = new Date("2026-01-01T00:00:00.000Z")
        const parent = {
          sessionId: SessionId.make("mutation-delete-parent"),
          branchId: BranchId.make("mutation-delete-parent-branch"),
        }

        yield* createActiveSessionFixture({ ...parent, sessions, branches, now })
        const child = yield* mutations.createChildSession({
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          cwd: "/tmp/mutation-delete-child",
        })

        yield* mutations.deleteSession(parent.sessionId)

        expect(runtimeTerminated).toEqual([parent.sessionId, child.sessionId])
        expect(terminated).toEqual([parent.sessionId, child.sessionId])
      }).pipe(Effect.provide(sessionMutationsLayerWithMachineProbe(terminated, runtimeTerminated))),
    )
  })

  it.live("restores runtime tombstones when durable delete fails", () => {
    const terminated: Array<SessionId> = []
    const runtimeTerminated: Array<SessionId> = []
    const runtimeRestored: Array<SessionId> = []
    return Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const sessions = yield* SessionStorage
        const branches = yield* BranchStorage
        const sessionId = SessionId.make("delete-failure-session")
        const branchId = BranchId.make("delete-failure-branch")

        yield* createActiveSessionFixture({
          sessions,
          branches,
          sessionId,
          branchId,
          now: new Date("2026-01-01T00:00:00.000Z"),
        })

        const exit = yield* Effect.exit(commands.deleteSession(sessionId))

        expect(exit._tag).toBe("Failure")
        expect(runtimeTerminated).toEqual([sessionId])
        expect(runtimeRestored).toEqual([sessionId])
        expect(terminated).toEqual([sessionId])
        expect(yield* sessions.getSession(sessionId)).not.toBeUndefined()
      }).pipe(
        Effect.provide(
          failingDeleteSessionCommandsLayerWithMachineProbe(
            terminated,
            runtimeTerminated,
            runtimeRestored,
          ),
        ),
      ),
    )
  })

  it.live("terminates descendant sessions through their owning cwd profile runtime", () => {
    const primaryTerminated: Array<SessionId> = []
    const profileTerminated = new Map<string, Array<SessionId>>([
      ["/tmp/delete-profile-parent", []],
      ["/tmp/delete-profile-child", []],
      ["/tmp/delete-profile-grandchild", []],
    ])

    return Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const cwdRegistry = yield* SessionCwdRegistry

        const parent = yield* commands.createSession({ cwd: "/tmp/delete-profile-parent" })
        const child = yield* commands.createChildSession({
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
          cwd: "/tmp/delete-profile-child",
        })
        const grandchild = yield* commands.createChildSession({
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
          cwd: "/tmp/delete-profile-grandchild",
        })

        yield* commands.deleteSession(parent.sessionId)

        expect(primaryTerminated).toEqual([])
        expect(profileTerminated.get("/tmp/delete-profile-parent")).toEqual([parent.sessionId])
        expect(profileTerminated.get("/tmp/delete-profile-child")).toEqual([child.sessionId])
        expect(profileTerminated.get("/tmp/delete-profile-grandchild")).toEqual([
          grandchild.sessionId,
        ])
        expect(yield* cwdRegistry.lookup(parent.sessionId)).toBeUndefined()
        expect(yield* cwdRegistry.lookup(child.sessionId)).toBeUndefined()
        expect(yield* cwdRegistry.lookup(grandchild.sessionId)).toBeUndefined()
      }).pipe(
        Effect.provide(
          sessionCommandsLayerWithProfileMachineProbes({
            primaryTerminated,
            profileTerminated,
          }),
        ),
      ),
    )
  })
})

describe("message.send", () => {
  it.live(
    "persists the user message and assistant reply through the public snapshot contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userText = "hello from acceptance"
          const assistantText = "acceptance reply"
          const { client } = yield* makeClient(assistantText)
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === assistantText),
              ),
            5_000,
            "assistant reply in session snapshot",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          ).toBe(true)
        }),
      ),
  )

  it.live("applies runSpec overrides through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "runSpec acceptance reply"
        const { layer: providerLayer, controls } = yield* createSequenceProvider([
          {
            ...textStep(assistantText),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/model")
              expect(request.reasoning).toBe("high")
            },
          },
        ])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use run spec",
          runSpec: {
            overrides: {
              modelId: ModelId.make("custom/model"),
              reasoningEffort: "high",
              systemPromptAddendum: "Extra public contract instructions",
            },
            tags: ["acceptance"],
          },
        })

        const snapshot = yield* waitFor(
          client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          5_000,
          "assistant reply from runSpec turn",
        )

        expect(
          snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some((part) => part.type === "text" && part.text === assistantText),
          ),
        ).toBe(true)
        yield* controls.assertDone()
      }),
    ),
  )

  it.live("threads runSpec parentToolCallId through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "parent tool call acceptance reply"
        const parentToolCallId = ToolCallId.make("tc-parent-acceptance")
        const { layer: providerLayer, controls } = yield* createSequenceProvider([
          {
            ...textStep(assistantText),
            assertRequest: (request) => {
              expect(JSON.stringify(request.prompt)).toContain(
                `parentToolCallId:${parentToolCallId}`,
              )
            },
          },
        ])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [],
            extensions: [parentToolCallProbeExtension],
          }),
        )
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "thread parent tool call id",
          runSpec: { parentToolCallId },
        })

        yield* waitFor(
          client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          5_000,
          "assistant reply from parentToolCallId turn",
        )

        yield* controls.assertDone()
      }),
    ),
  )

  it.live("rejects a deleted session before provider dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* createSequenceProvider([
          textStep("should not run"),
        ])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })

        const exit = yield* Effect.exit(
          client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "deleted session",
          }),
        )

        expect(exit._tag).toBe("Failure")
        expect(yield* controls.callCount).toBe(0)
      }),
    ),
  )
})
