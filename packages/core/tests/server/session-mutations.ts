import { Predicate, Deferred, Effect, Layer, Stream } from "effect"
import { RpcClient, RpcTest } from "effect/unstable/rpc"
import { defineExtension, ExtensionContext, ExtensionHost } from "@gent/core/extensions/api"
import { LanguageModelLayers, textStep } from "../../src/test-utils/language-model"
import { ExtensionRegistry } from "../../src/runtime/extension-host.js"
import type { BranchId, SessionId } from "../../src/domain/ids"
import { Branch, dateFromMillis, emptyQueueSnapshot, Session } from "../../src/domain/message"
import { AgentName } from "../../src/domain/agent"
import { EventPublisher, EventStore, EventStoreError } from "../../src/domain/event"
import { ModelResolver } from "../../src/runtime/provider"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { SessionRuntime, type SessionRuntimeService } from "../../src/runtime/session"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent-loop"
import { GentRpcs } from "../../src/server/rpc"
import { RpcHandlersLive, SessionMutationsLive } from "../../src/server/server"
import { WORKSPACE_ID_HEADER, WorkspaceId } from "../../src/server/workspace-rpc"
import {
  BranchStorage,
  type BranchStorageService,
  SessionStorage,
  type SessionStorageService,
  SqliteStorage,
  StorageError,
} from "../../src/storage/storage"
import { createE2ELayer, createRpcClient } from "../../src/test-utils/harness"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"

export const FIXED_NOW = dateFromMillis(1_767_225_600_000)
export const datePlusMillis = (date: Date, millis: number): Date =>
  dateFromMillis(date.getTime() + millis)

export const makeClient = (reply = "ok") =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep(reply)])
    return yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
  })

const rpcTestWorkspaceId = WorkspaceId.make("c".repeat(64))

/**
 * RPC client over `RpcHandlersLive` with the production e2e root underneath
 * and a stub `SessionRuntime` on top. The stub shadows the root's runtime so
 * a test can count or fail dispatches while the `message.send` handler runs
 * its real request-id dedup.
 */
export const makeRpcHandlersClient = (
  runtimeOverrides: Partial<SessionRuntimeService> = {},
  extraLayer: Layer.Layer<never> = Layer.empty,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.provide(
        RpcHandlersLive,
        Layer.mergeAll(
          createE2ELayer({ ...e2ePreset, providerLayer: LanguageModelLayers.debug() }),
          sessionRuntimeLayer(runtimeOverrides),
          extraLayer,
        ),
      ),
    )
    // oxlint-disable-next-line effect/noInlineProvide -- This test composes the handler context for this client.
    const client = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
    const inWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      RpcClient.withHeaders(effect, { [WORKSPACE_ID_HEADER]: rpcTestWorkspaceId })
    return { client, inWorkspace }
  })

export const collectSessionEvents = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()

    yield* stream.pipe(
      Stream.runForEach(() => Deferred.succeed(ready, void 0).pipe(Effect.ignore)),
      Effect.ensuring(Deferred.succeed(closed, void 0).pipe(Effect.ignore)),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    return closed
  })

export const failingPublisherLayer = Layer.succeed(
  EventPublisher,
  EventPublisher.of({
    append: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
    deliver: () => Effect.void,
    publish: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
  }),
)

export const sessionRuntimeLayer = (
  overrides: Partial<SessionRuntimeService> = {},
): Layer.Layer<SessionRuntime> =>
  Layer.succeed(
    SessionRuntime,
    SessionRuntime.of({
      sendUserMessage: () => Effect.void,
      steer: () => Effect.void,
      respondInteraction: () => Effect.void,
      queueFollowUp: () => Effect.void,
      dequeueFollowUp: () => Effect.succeed(false),
      requestExtension: () => Effect.void,
      drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
      getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
      getState: () =>
        Effect.succeed({
          _tag: "Idle",
          agent: AgentName.make("cowork"),
          queue: emptyQueueSnapshot(),
        }),
      watchState: () => Effect.succeed(Stream.empty),
      terminateSession: () => Effect.void,
      ...overrides,
    }),
  )

const buildFailingSessionMutationsLayer = () => {
  const storageLayer = SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
    Layer.provide(GentPlatform.Test()),
  )
  const deps = Layer.mergeAll(
    storageLayer,
    sessionRuntimeLayer(),
    sessionGovernanceProbeLayer(),
    EventStore.Memory,
    failingPublisherLayer,
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
    ExtensionRegistry.Test(),
  )
  return Layer.provideMerge(SessionMutationsLive, deps)
}

export const failingSessionMutationsLayer = Layer.fresh(
  Layer.unwrap(Effect.sync(buildFailingSessionMutationsLayer)),
)

export const createActiveSessionFixture = Effect.fn("createActiveSessionFixture")(
  function* (input: {
    readonly sessions: SessionStorageService
    readonly branches: BranchStorageService
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly now: Date
    readonly name?: string
    readonly cwd?: string
    readonly parentSessionId?: SessionId
    readonly parentBranchId?: BranchId
  }) {
    const session = new Session({
      id: input.sessionId,
      name: input.name,
      cwd: input.cwd,
      parentSessionId: input.parentSessionId,
      parentBranchId: input.parentBranchId,
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

const buildSessionMutationsLayer = () => {
  const storageLayer = SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
    Layer.provide(GentPlatform.Test()),
  )
  const deps = Layer.mergeAll(
    storageLayer,
    sessionRuntimeLayer(),
    sessionGovernanceProbeLayer(),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
    ExtensionRegistry.Test(),
  )
  return Layer.provideMerge(SessionMutationsLive, deps)
}

export const sessionMutationsLayer = Layer.fresh(
  Layer.unwrap(Effect.sync(buildSessionMutationsLayer)),
)

export const sessionRuntimeProbeLayer = (terminated: Array<SessionId>) =>
  sessionRuntimeLayer({
    terminateSession: (sessionId) =>
      Effect.sync(() => {
        terminated.push(sessionId)
      }),
  })

const sessionGovernanceProbeLayer = (restored?: Array<SessionId>) =>
  Layer.succeed(
    AgentLoopSessionGovernance,
    AgentLoopSessionGovernance.of({
      markTerminated: () => Effect.void,
      clearTerminated: (_workspaceId, sessionId) =>
        Effect.sync(() => {
          restored?.push(sessionId)
        }),
      isTerminated: () => Effect.succeed(false),
    }),
  )

export const sessionMutationsLayerWithMachineProbe = (
  runtimeTerminated?: Array<SessionId>,
  runtimeRestored?: Array<SessionId>,
) => {
  const storageLayer = SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
    Layer.provide(GentPlatform.Test()),
  )
  let runtimeLayer = sessionRuntimeLayer()
  if (!Predicate.isUndefined(runtimeTerminated)) {
    runtimeLayer = sessionRuntimeProbeLayer(runtimeTerminated)
  }
  const deps = Layer.mergeAll(
    storageLayer,
    runtimeLayer,
    sessionGovernanceProbeLayer(runtimeRestored),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
    ExtensionRegistry.Test(),
  )
  return Layer.provideMerge(SessionMutationsLive, deps)
}

export const failingDeleteSessionMutationsLayerWithMachineProbe = (
  runtimeTerminated: Array<SessionId>,
  runtimeRestored: Array<SessionId>,
) => {
  const storageLayer = SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
    Layer.provide(GentPlatform.Test()),
  )
  const failingSessionStorageLayer = Layer.effect(
    SessionStorage,
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      return SessionStorage.of({
        ...sessions,
        deleteSession: () => Effect.fail(new StorageError({ message: "delete failed" })),
      })
    }),
  ).pipe(Layer.provide(storageLayer))
  const deps = Layer.mergeAll(
    storageLayer,
    failingSessionStorageLayer,
    sessionRuntimeProbeLayer(runtimeTerminated),
    sessionGovernanceProbeLayer(runtimeRestored),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
    ExtensionRegistry.Test(),
  )
  return Layer.provideMerge(SessionMutationsLive, deps)
}

/**
 * SessionMutations layer that injects a child-session create into the DB
 * between the pre-collect and the durable `deleteSession` tx. Simulates the
 * race the audit flagged: a new descendant committing after
 * `collectSessionTreeIds` runs but before the cascade tx opens. Fires once
 * for any deleteSession call, inserting a child pointed at the deleted root.
 */
export const racySessionMutationsLayer = (params: {
  readonly runtimeTerminated: Array<SessionId>
  readonly lateChild: { sessionId: SessionId; branchId: BranchId }
}) => {
  const storageLayer = SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
    Layer.provide(GentPlatform.Test()),
  )
  const racingSessionStorageLayer = Layer.effect(
    SessionStorage,
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      let fired = false
      return SessionStorage.of({
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
      })
    }),
  ).pipe(Layer.provide(storageLayer))
  const deps = Layer.mergeAll(
    storageLayer,
    racingSessionStorageLayer,
    sessionRuntimeProbeLayer(params.runtimeTerminated),
    sessionGovernanceProbeLayer(),
    EventStore.Memory,
    EventPublisher.Test(),
    LanguageModelLayers.debug(),
    ModelResolver.fromLanguageModel(LanguageModelLayers.debug()),
    GentPlatform.Test(),
    ExtensionRegistry.Test(),
  )
  return Layer.provideMerge(SessionMutationsLive, deps)
}

export const parentToolCallProbeExtension = defineExtension({
  id: "parent-tool-call-probe",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        let promptSections: ReadonlyArray<{
          readonly id: string
          readonly content: string
          readonly priority: number
        }> = []
        if (!Predicate.isUndefined(ctx.turn?.parentToolCallId)) {
          promptSections = [
            {
              id: "parent-tool-call-probe",
              content: `parentToolCallId:${ctx.turn.parentToolCallId}`,
              priority: 45,
            },
          ]
        }
        return { promptSections }
      }),
    )
  }),
})
