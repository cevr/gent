import { describe, it, expect } from "effect-bun-test"
import { Cause, Context, Deferred, Effect, Layer, Logger, Option, Stream } from "effect"
import { textStep } from "@gent/core/debug/provider"
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
    const { layer: providerLayer } = yield* Provider.Sequence([textStep(reply)])
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

/**
 * SessionCommands layer that injects a child-session create into the DB
 * between the pre-collect and the durable `deleteSession` tx. Simulates the
 * race the audit flagged: a new descendant committing after
 * `collectSessionTreeIds` runs but before the cascade tx opens. Fires once
 * for any deleteSession call, inserting a child pointed at the deleted root.
 */
const racySessionCommandsLayer = (params: {
  readonly terminated: Array<SessionId>
  readonly runtimeTerminated: Array<SessionId>
  readonly lateChild: { sessionId: SessionId; branchId: BranchId }
}) => {
  const storageLayer = Storage.MemoryWithSql()
  const baseSubTags = subTagLayers(storageLayer)
  const racingSessionStorageLayer = Layer.effect(
    SessionStorage,
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      let fired = false
      return {
        ...sessions,
        deleteSession: (rootId: SessionId) =>
          Effect.gen(function* () {
            if (!fired) {
              fired = true
              const now = new Date("2026-01-01T00:00:00.000Z")
              yield* sessions.createSession(
                new Session({
                  id: params.lateChild.sessionId,
                  cwd: "/tmp/racing-late-child",
                  parentSessionId: rootId,
                  createdAt: now,
                  updatedAt: now,
                }),
              )
              yield* branches.createBranch(
                new Branch({
                  id: params.lateChild.branchId,
                  sessionId: params.lateChild.sessionId,
                  createdAt: now,
                }),
              )
            }
            return yield* sessions.deleteSession(rootId)
          }),
      }
    }),
  ).pipe(Layer.provide(baseSubTags))

  const machineProbeLayer = Layer.succeed(MachineEngine, {
    publish: () => Effect.succeed([]),
    send: () => Effect.void,
    execute: () => Effect.die("unexpected machine request"),
    getActorStatuses: () => Effect.succeed([]),
    terminateAll: (sessionId) =>
      Effect.sync(() => {
        params.terminated.push(sessionId)
      }),
  } satisfies MachineEngineService)
  const deps = Layer.mergeAll(
    storageLayer,
    baseSubTags,
    racingSessionStorageLayer,
    sessionRuntimeProbeLayer(params.runtimeTerminated),
    SessionCommands.SessionRuntimeTerminatorLive,
    EventStore.Memory,
    EventPublisher.Test(),
    Provider.Debug(),
    machineProbeLayer,
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
    }).pipe(Effect.provide(sendFailingSessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
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
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("NotFoundError")
      }
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(failingSessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("does not roll back committed rows when post-commit delivery fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage

      const exit = yield* Effect.exit(commands.createSession({ cwd: "/tmp/post-commit" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(1)
    }).pipe(Effect.provide(postCommitFailingSessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("InvalidStateError")
      }
      expect(yield* branches.getBranch(parentBranchId)).toBeDefined()
      expect(yield* branches.getBranch(childBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("InvalidStateError")
      }
      expect(yield* branches.getBranch(parentBranchId)).toBeDefined()
      expect(yield* sessions.getSession(child.sessionId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("InvalidStateError")
      }
      expect(yield* branches.getBranch(activeBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("NotFoundError")
      }
      expect(yield* branches.getBranch(otherBranchId)).toBeDefined()
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
      if (exit._tag === "Failure") {
        const fail = exit.cause.reasons.find(Cause.isFailReason)
        expect(fail).toBeDefined()
        expect(fail?.error._tag).toBe("NotFoundError")
      }
      expect((yield* messages.listMessages(branchId)).map((message) => message.id)).toEqual([
        ownerMessageId,
      ])
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
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
      }).pipe(Effect.timeout("4 seconds")),
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("closes runtime streams and interrupts active loops on public delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* Provider.Signal("delete me later")
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
      }).pipe(Effect.timeout("4 seconds")),
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
      }).pipe(Effect.timeout("4 seconds")),
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
      }).pipe(
        Effect.provide(sessionCommandsLayerWithMachineProbe(terminated, runtimeTerminated)),
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live("cleans runtime state for a child created mid-cascade", () => {
    const terminated: Array<SessionId> = []
    const runtimeTerminated: Array<SessionId> = []
    const lateChildSessionId = SessionId.make("race-late-child")
    const lateChildBranchId = BranchId.make("race-late-child-branch")
    return Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const sessions = yield* SessionStorage

        const parent = yield* commands.createSession({ cwd: "/tmp/race-parent" })

        yield* commands.deleteSession(parent.sessionId)

        expect(yield* sessions.getSession(parent.sessionId)).toBeUndefined()
        expect(yield* sessions.getSession(lateChildSessionId)).toBeUndefined()
        expect(runtimeTerminated.sort()).toEqual([parent.sessionId, lateChildSessionId].sort())
        expect(terminated.sort()).toEqual([parent.sessionId, lateChildSessionId].sort())
      }).pipe(
        Effect.provide(
          racySessionCommandsLayer({
            terminated,
            runtimeTerminated,
            lateChild: {
              sessionId: lateChildSessionId,
              branchId: lateChildBranchId,
            },
          }),
        ),
        Effect.timeout("4 seconds"),
      ),
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
      }).pipe(
        Effect.provide(sessionMutationsLayerWithMachineProbe(terminated, runtimeTerminated)),
        Effect.timeout("4 seconds"),
      ),
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
        Effect.timeout("4 seconds"),
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
        Effect.timeout("4 seconds"),
      ),
    )
  })

  it.live(
    "rejects public read boundaries for deleted sessions (events, watchRuntime, getState, getMetrics, queue.get)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const created = yield* client.session.create({ cwd: process.cwd() })
          yield* client.session.delete({ sessionId: created.sessionId })

          const expectSessionNotFound = (exit: {
            readonly _tag: "Success" | "Failure"
            readonly cause?: Cause.Cause<unknown>
          }) => {
            expect(exit._tag).toBe("Failure")
            if (exit._tag === "Failure" && exit.cause !== undefined) {
              const message = String(Cause.squash(exit.cause))
              expect(message.toLowerCase()).toMatch(/session.*(not found|terminated)/)
            }
          }

          const eventsExit = yield* Effect.exit(
            client.session
              .events({ sessionId: created.sessionId })
              .pipe(Stream.runDrain, Effect.timeout("5 seconds")),
          )
          expectSessionNotFound(eventsExit)

          const watchExit = yield* Effect.exit(
            client.session
              .watchRuntime({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Stream.runDrain, Effect.timeout("5 seconds")),
          )
          expectSessionNotFound(watchExit)

          const stateExit = yield* Effect.exit(
            client.actor.getState({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )
          expectSessionNotFound(stateExit)

          const metricsExit = yield* Effect.exit(
            client.actor.getMetrics({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )
          expectSessionNotFound(metricsExit)

          const queueExit = yield* Effect.exit(
            client.queue.get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )
          expectSessionNotFound(queueExit)
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("terminates an active subscription mid-delete (subscribe-then-delete race)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        // Subscribe while the session is alive, then delete it while
        // the stream is still attached. The subscription must terminate
        // (either via interruption on loop close, or by the event-store
        // propagating session-gone). A hang means the principle of
        // terminal-state-exit-safety is violated.
        const closed = yield* collectSessionEvents(
          client.session.events({ sessionId: created.sessionId }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
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
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("applies runSpec overrides through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "runSpec acceptance reply"
        const { layer: providerLayer, controls } = yield* Provider.Sequence([
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("threads runSpec parentToolCallId through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "parent tool call acceptance reply"
        const parentToolCallId = ToolCallId.make("tc-parent-acceptance")
        const { layer: providerLayer, controls } = yield* Provider.Sequence([
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("rejects a deleted session before provider dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* Provider.Sequence([
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

describe("requestId idempotency", () => {
  it.live("duplicate createSession requestId converges on a single session id", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const first = yield* commands.createSession({
        cwd: "/tmp/idem",
        requestId: "req-create-1",
      })
      const second = yield* commands.createSession({
        cwd: "/tmp/idem",
        requestId: "req-create-1",
      })
      const third = yield* commands.createSession({
        cwd: "/tmp/idem",
        requestId: "req-create-1",
      })
      expect(second.sessionId).toBe(first.sessionId)
      expect(second.branchId).toBe(first.branchId)
      expect(third.sessionId).toBe(first.sessionId)
      const all = yield* sessions.listSessions()
      expect(all).toHaveLength(1)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("distinct createSession requestIds create distinct sessions", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const a = yield* commands.createSession({ cwd: "/tmp/a", requestId: "req-a" })
      const b = yield* commands.createSession({ cwd: "/tmp/b", requestId: "req-b" })
      expect(a.sessionId).not.toBe(b.sessionId)
      expect((yield* sessions.listSessions()).length).toBe(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate createSession requestIds converge on one session", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      // Fire three parallel creates with the same requestId. Before the
      // Deferred-based claim this would race two `Ref.get` misses through
      // storage and leave two sessions. Under the atomic claim the first
      // fiber wins the write; the others `Deferred.await` its outcome.
      const results = yield* Effect.all(
        [
          commands.createSession({ cwd: "/tmp/conc", requestId: "req-conc-1" }),
          commands.createSession({ cwd: "/tmp/conc", requestId: "req-conc-1" }),
          commands.createSession({ cwd: "/tmp/conc", requestId: "req-conc-1" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0].sessionId).toBe(results[1].sessionId)
      expect(results[0].sessionId).toBe(results[2].sessionId)
      expect((yield* sessions.listSessions()).length).toBe(1)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("duplicate sendMessage requestId dispatches the runtime only once", () =>
    Effect.gen(function* () {
      let dispatchCount = 0
      const countingRuntime = Layer.succeed(SessionRuntime, {
        dispatch: () =>
          Effect.sync(() => {
            dispatchCount++
          }),
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
      const storageLayer = Storage.MemoryWithSql()
      const deps = Layer.mergeAll(
        storageLayer,
        subTagLayers(storageLayer),
        countingRuntime,
        SessionCommands.SessionRuntimeTerminatorLive,
        EventStore.Memory,
        EventPublisher.Test(),
        Provider.Debug(),
        MachineEngine.Test(),
        SessionCwdRegistry.Test(),
      )
      const layer = Layer.provideMerge(SessionCommands.Live, deps)

      const probe = Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* commands.sendMessage({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          content: "hi",
          requestId: "req-send-1",
        })
        yield* commands.sendMessage({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          content: "hi",
          requestId: "req-send-1",
        })
        yield* commands.sendMessage({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
          content: "hi (distinct)",
          requestId: "req-send-2",
        })
      }).pipe(Effect.provide(layer))

      yield* probe
      expect(dispatchCount).toBe(2)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate sendMessage requestIds dispatch only once", () =>
    Effect.gen(function* () {
      let dispatchCount = 0
      const countingRuntime = Layer.succeed(SessionRuntime, {
        dispatch: () =>
          Effect.sync(() => {
            dispatchCount++
          }),
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
      const storageLayer = Storage.MemoryWithSql()
      const deps = Layer.mergeAll(
        storageLayer,
        subTagLayers(storageLayer),
        countingRuntime,
        SessionCommands.SessionRuntimeTerminatorLive,
        EventStore.Memory,
        EventPublisher.Test(),
        Provider.Debug(),
        MachineEngine.Test(),
        SessionCwdRegistry.Test(),
      )
      const layer = Layer.provideMerge(SessionCommands.Live, deps)

      yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        yield* Effect.all(
          [
            commands.sendMessage({
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              content: "hi",
              requestId: "req-conc-send",
            }),
            commands.sendMessage({
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              content: "hi",
              requestId: "req-conc-send",
            }),
            commands.sendMessage({
              sessionId: SessionId.make("s1"),
              branchId: BranchId.make("b1"),
              content: "hi",
              requestId: "req-conc-send",
            }),
          ],
          { concurrency: "unbounded" },
        )
      }).pipe(Effect.provide(layer))

      expect(dispatchCount).toBe(1)
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("duplicate createBranch requestId converges on a single branch id", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const branches = yield* BranchStorage
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-branch-dedup")
      const branchId = BranchId.make("branch-branch-dedup")
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: new Date(),
      })

      const first = yield* commands.createBranch({
        sessionId,
        name: "feat",
        requestId: "req-branch-1",
      })
      const second = yield* commands.createBranch({
        sessionId,
        name: "feat",
        requestId: "req-branch-1",
      })

      expect(second.branchId).toBe(first.branchId)
      // 1 from fixture + 1 from the deduped create
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("concurrent duplicate createBranch requestIds converge on one branch", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const branches = yield* BranchStorage
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-branch-conc")
      const branchId = BranchId.make("branch-branch-conc")
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now: new Date(),
      })

      const results = yield* Effect.all(
        [
          commands.createBranch({ sessionId, name: "x", requestId: "req-bconc" }),
          commands.createBranch({ sessionId, name: "x", requestId: "req-bconc" }),
          commands.createBranch({ sessionId, name: "x", requestId: "req-bconc" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0].branchId).toBe(results[1].branchId)
      expect(results[0].branchId).toBe(results[2].branchId)
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("duplicate switchBranch requestId activates the target only once", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-dedup")
      const fromBranchId = BranchId.make("branch-switch-dedup-from")
      const toBranchId = BranchId.make("branch-switch-dedup-to")
      const now = new Date()
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId: fromBranchId,
        now,
      })
      yield* branches.createBranch(new Branch({ id: toBranchId, sessionId, createdAt: now }))

      yield* commands.switchBranch({
        sessionId,
        fromBranchId,
        toBranchId,
        summarize: false,
        requestId: "req-switch-1",
      })
      yield* commands.switchBranch({
        sessionId,
        fromBranchId,
        toBranchId,
        summarize: false,
        requestId: "req-switch-1",
      })

      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(toBranchId)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )

  it.live("duplicate forkBranch requestId converges on a single new branch", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-fork-dedup")
      const branchId = BranchId.make("branch-fork-dedup")
      const messageId = MessageId.make("message-fork-dedup")
      const now = new Date()
      yield* createActiveSessionFixture({
        sessions,
        branches,
        sessionId,
        branchId,
        now,
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

      const first = yield* commands.forkBranch({
        sessionId,
        fromBranchId: branchId,
        atMessageId: messageId,
        name: "fork",
        requestId: "req-fork-1",
      })
      const second = yield* commands.forkBranch({
        sessionId,
        fromBranchId: branchId,
        atMessageId: messageId,
        name: "fork",
        requestId: "req-fork-1",
      })

      expect(second.branchId).toBe(first.branchId)
      // origin + 1 forked branch
      expect(yield* branches.listBranches(sessionId)).toHaveLength(2)
    }).pipe(Effect.provide(sessionCommandsLayer()), Effect.timeout("4 seconds")),
  )
})
