import { Deferred, Effect, Layer, Stream } from "effect"
import { ExtensionContext } from "@gent/core/extensions/api"
import { textStep } from "@gent/core-internal/debug/provider"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { Branch, dateFromMillis, Session } from "@gent/core-internal/domain/message"
import { emptyQueueSnapshot } from "@gent/core-internal/domain/queue"
import { EventStore, EventStoreError } from "@gent/core-internal/domain/event"
import { EventPublisher } from "@gent/core-internal/domain/event-publisher"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import {
  SessionRuntime,
  SessionRuntimeError,
  type SessionRuntimeService,
} from "../../../src/runtime/session-runtime"
import { SessionCommands } from "../../../src/server/session-commands"
import {
  BranchStorage,
  type BranchStorageService,
} from "@gent/core-internal/storage/branch-storage"
import {
  SessionStorage,
  type SessionStorageService,
} from "@gent/core-internal/storage/session-storage"
import { SqliteStorage, StorageError } from "@gent/core-internal/storage/sqlite-storage"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../../../../extensions/tests/helpers/test-preset"
import type { LoadedExtension } from "../../../src/domain/extension"

export const FIXED_NOW = dateFromMillis(1_767_225_600_000)
export const datePlusMillis = (date: Date, millis: number): Date =>
  dateFromMillis(date.getTime() + millis)

export const makeClient = (reply = "ok") =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep(reply)])
    return yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
  })

export const collectSessionEvents = <A, E>(stream: Stream.Stream<A, E>) =>
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

export const failingPublisherLayer = Layer.succeed(EventPublisher, {
  append: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
  deliver: () => Effect.void,
  publish: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
})

export const sessionRuntimeLayer = (
  overrides: Partial<SessionRuntimeService> = {},
): Layer.Layer<SessionRuntime> =>
  Layer.succeed(SessionRuntime, {
    sendUserMessage: () => Effect.void,
    steer: () => Effect.void,
    respondInteraction: () => Effect.void,
    runPrompt: () => Effect.void,
    queueFollowUp: () => Effect.void,
    drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
    getMetrics: () =>
      Effect.succeed({
        turns: 0,
        tokens: 0,
        toolCalls: 0,
        retries: 0,
        durationMs: 0,
        costUsd: 0,
        lastInputTokens: 0,
      }),
    watchState: () => Effect.succeed(Stream.empty),
    terminateSession: () => Effect.void,
    restoreSession: () => Effect.void,
    ...overrides,
  })

export const failingSessionCommandsLayer = () => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
  const deps = Layer.mergeAll(
    storageLayer,
    sessionRuntimeLayer(),
    EventStore.Memory,
    failingPublisherLayer,
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
  )
  return Layer.provideMerge(
    SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
    deps,
  )
}

export const createActiveSessionFixture = Effect.fn("createActiveSessionFixture")(
  function* (input: {
    readonly sessions: SessionStorageService
    readonly branches: BranchStorageService
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
  },
)

export const sendFailingSessionCommandsLayer = () => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
  const failingRuntimeLayer = sessionRuntimeLayer({
    sendUserMessage: () => Effect.fail(new SessionRuntimeError({ message: "runtime failed" })),
  })
  const deps = Layer.mergeAll(
    storageLayer,
    failingRuntimeLayer,
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
  )
  return Layer.provideMerge(
    SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
    deps,
  )
}

export const sessionCommandsLayer = () => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
  const deps = Layer.mergeAll(
    storageLayer,
    sessionRuntimeLayer(),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
  )
  return Layer.provideMerge(
    SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
    deps,
  )
}

export const sessionRuntimeProbeLayer = (
  terminated: Array<SessionId>,
  restored?: Array<SessionId>,
) =>
  sessionRuntimeLayer({
    terminateSession: (sessionId) =>
      Effect.sync(() => {
        terminated.push(sessionId)
      }),
    restoreSession: (sessionId) =>
      Effect.sync(() => {
        restored?.push(sessionId)
      }),
  })

export const sessionCommandsLayerWithMachineProbe = (
  runtimeTerminated?: Array<SessionId>,
  runtimeRestored?: Array<SessionId>,
) => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
  const deps = Layer.mergeAll(
    storageLayer,
    runtimeTerminated === undefined
      ? sessionRuntimeLayer()
      : sessionRuntimeProbeLayer(runtimeTerminated, runtimeRestored),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
  )
  return Layer.provideMerge(
    SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
    deps,
  )
}

export const sessionMutationsLayerWithMachineProbe = (runtimeTerminated: Array<SessionId>) => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
  const runtimeLayer = sessionRuntimeProbeLayer(runtimeTerminated)
  const deps = Layer.mergeAll(
    storageLayer,
    runtimeLayer,
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
  )
  return Layer.provideMerge(SessionCommands.SessionMutationsLive, deps)
}

export const failingDeleteSessionCommandsLayerWithMachineProbe = (
  runtimeTerminated: Array<SessionId>,
  runtimeRestored: Array<SessionId>,
) => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
  const failingSessionStorageLayer = Layer.effect(
    SessionStorage,
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      return {
        ...sessions,
        deleteSession: () => Effect.fail(new StorageError({ message: "delete failed" })),
      }
    }),
  ).pipe(Layer.provide(storageLayer))
  const deps = Layer.mergeAll(
    storageLayer,
    failingSessionStorageLayer,
    sessionRuntimeProbeLayer(runtimeTerminated, runtimeRestored),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
  )
  return Layer.provideMerge(
    SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
    deps,
  )
}

/**
 * SessionCommands layer that injects a child-session create into the DB
 * between the pre-collect and the durable `deleteSession` tx. Simulates the
 * race the audit flagged: a new descendant committing after
 * `collectSessionTreeIds` runs but before the cascade tx opens. Fires once
 * for any deleteSession call, inserting a child pointed at the deleted root.
 */
export const racySessionCommandsLayer = (params: {
  readonly runtimeTerminated: Array<SessionId>
  readonly lateChild: { sessionId: SessionId; branchId: BranchId }
}) => {
  const storageLayer = SqliteStorage.MemoryWithSql().pipe(Layer.provide(GentPlatform.Test()))
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
              const now = FIXED_NOW
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
  ).pipe(Layer.provide(storageLayer))
  const deps = Layer.mergeAll(
    storageLayer,
    racingSessionStorageLayer,
    sessionRuntimeProbeLayer(params.runtimeTerminated),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
  )
  return Layer.provideMerge(
    SessionCommands.Live.pipe(Layer.provideMerge(SessionCommands.SessionMutationsLive)),
    deps,
  )
}

export const parentToolCallProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("parent-tool-call-probe") },
  scope: "builtin",
  sourcePath: "test",
  contributions: {
    reactions: {
      turnProjection: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          return {
            promptSections:
              ctx.turn?.parentToolCallId === undefined
                ? []
                : [
                    {
                      id: "parent-tool-call-probe",
                      content: `parentToolCallId:${ctx.turn.parentToolCallId}`,
                      priority: 45,
                    },
                  ],
          }
        }),
    },
  },
}
