import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { EventStore, AgentSwitched } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { SessionId } from "@gent/core/domain/ids"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Provider } from "@gent/core/providers/provider"
import { AppServicesLive } from "@gent/core/server/index"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { SessionQueries } from "@gent/core/server/session-queries"
import { SessionCommands } from "@gent/core/server/session-commands"
import { ActorProcess } from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"

describe("Session Snapshot", () => {
  it.live("getSessionSnapshot only returns persisted state", () => {
    const eventStoreLayer = EventStore.Test()
    const actorProcessLayer = Layer.succeed(ActorProcess, {
      sendUserMessage: () => Effect.void,
      sendToolResult: () => Effect.void,
      invokeTool: () => Effect.void,
      interrupt: () => Effect.void,
      steerAgent: () => Effect.void,
      drainQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
      getState: () =>
        Effect.succeed({
          phase: "streaming" as const,
          status: "running" as const,
          agent: "deepwork" as const,
          queue: { steering: [], followUp: [] },
          lastError: undefined,
        }),
      getMetrics: () =>
        Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
    })
    const baseWithEventStore = Layer.mergeAll(
      Storage.TestWithSql(),
      Provider.Test([]),
      eventStoreLayer,
      actorProcessLayer,
      ExtensionStateRuntime.Test(),
      Permission.Live([], "allow"),
      ConfigService.Test(),
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, baseWithEventStore)
    const deps = Layer.mergeAll(
      baseWithEventStore,
      eventPublisherLayer,
      AgentLoop.Test(),
      ApprovalService.Test(),
    )
    const testLayer = Layer.provideMerge(AppServicesLive, deps)

    return Effect.gen(function* () {
      const commands = yield* SessionCommands
      const queries = yield* SessionQueries
      const storage = yield* Storage
      const session = yield* commands.createSession({ name: "Test Session" })
      yield* storage.appendEvent(
        new AgentSwitched({
          sessionId: session.sessionId,
          branchId: session.branchId,
          fromAgent: "deepwork",
          toAgent: "cowork",
        }),
      )

      const result = yield* queries.getSessionSnapshot({
        sessionId: session.sessionId,
        branchId: session.branchId,
      })
      expect(result.sessionId).toBeDefined()
      expect(result.messages).toEqual([])
    }).pipe(Effect.provide(testLayer))
  })
})

describe("Session Tree", () => {
  const makeTestLayer = () => {
    const eventStoreLayer = EventStore.Test()
    const baseWithEventStore = Layer.mergeAll(
      Storage.TestWithSql(),
      Provider.Test([]),
      eventStoreLayer,
      ActorProcess.Test(),
      ExtensionStateRuntime.Test(),
      Permission.Live([], "allow"),
      ConfigService.Test(),
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, baseWithEventStore)
    const deps = Layer.mergeAll(
      baseWithEventStore,
      eventPublisherLayer,
      AgentLoop.Test(),
      ApprovalService.Test(),
    )
    return Layer.provideMerge(AppServicesLive, deps)
  }

  it.live("getChildSessions returns direct children", () => {
    const testLayer = makeTestLayer()
    return Effect.gen(function* () {
      const commands = yield* SessionCommands
      const queries = yield* SessionQueries
      const parent = yield* commands.createSession({ name: "Parent" })
      yield* commands.createSession({
        name: "Child 1",
        parentSessionId: parent.sessionId,
        parentBranchId: parent.branchId,
      })
      yield* commands.createSession({
        name: "Child 2",
        parentSessionId: parent.sessionId,
        parentBranchId: parent.branchId,
      })
      const result = yield* queries.getChildSessions(parent.sessionId)
      expect(result.length).toBe(2)
    }).pipe(Effect.provide(testLayer))
  })

  it.live("getSessionTree builds recursive hierarchy", () => {
    const testLayer = makeTestLayer()
    return Effect.gen(function* () {
      const commands = yield* SessionCommands
      const queries = yield* SessionQueries
      const root = yield* commands.createSession({ name: "Root" })
      const child = yield* commands.createSession({
        name: "Child",
        parentSessionId: root.sessionId,
        parentBranchId: root.branchId,
      })
      yield* commands.createSession({
        name: "Grandchild",
        parentSessionId: child.sessionId,
        parentBranchId: child.branchId,
      })
      const result = yield* queries.getSessionTree(root.sessionId)
      expect(result.session.name).toBe("Root")
      expect(result.children.length).toBe(1)
      expect(result.children[0]!.session.name).toBe("Child")
      expect(result.children[0]!.children.length).toBe(1)
      expect(result.children[0]!.children[0]!.session.name).toBe("Grandchild")
    }).pipe(Effect.provide(testLayer))
  })

  it.live("createSession rejects invalid parentSessionId", () => {
    const testLayer = makeTestLayer()
    return Effect.gen(function* () {
      const commands = yield* SessionCommands
      const result = yield* Effect.result(
        commands.createSession({
          name: "Orphan",
          parentSessionId: SessionId.of("nonexistent"),
        }),
      )
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(testLayer))
  })

  it.live("createSession threads parentSessionId to storage", () => {
    const testLayer = makeTestLayer()
    return Effect.gen(function* () {
      const commands = yield* SessionCommands
      const queries = yield* SessionQueries
      const parent = yield* commands.createSession({ name: "Parent" })
      const child = yield* commands.createSession({
        name: "Child",
        parentSessionId: parent.sessionId,
        parentBranchId: parent.branchId,
      })
      const result = yield* queries.getSession(child.sessionId)
      expect(result).not.toBeNull()
      expect(result!.parentSessionId).toBeDefined()
    }).pipe(Effect.provide(testLayer))
  })
})
