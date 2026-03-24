import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EventStore } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import {
  PermissionHandler,
  PromptHandler,
  HandoffHandler,
} from "@gent/core/domain/interaction-handlers"
import type { ActorCommandId, BranchId, MessageId, SessionId } from "@gent/core/domain/ids"
import { Branch, Message, Session, TextPart, ToolResultPart } from "@gent/core/domain/message"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Provider } from "@gent/core/providers/provider"
import { AppServicesLive } from "@gent/core/server/index"
import { SessionCommands } from "@gent/core/server/session-commands"
import {
  ActorProcess,
  ClusterActorProcessLive,
  DurableActorProcessLive,
  LocalActorProcessLive,
  LocalActorTransportLive,
  SessionActorEntityLocalLive,
} from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ClusterMemoryLive } from "@gent/core/runtime/cluster-layer"
import { ConfigService } from "@gent/core/runtime/config-service"

describe("SessionCommands → ActorProcess integration", () => {
  const makeActorProcessLayer = (
    storageDeps: Layer.Layer<Storage | EventStore | AgentLoop | ToolRunner, never, never>,
    mode: "local" | "cluster",
  ) => {
    if (mode === "cluster") {
      const entityLive = SessionActorEntityLocalLive.pipe(
        Layer.provide(storageDeps),
        Layer.provideMerge(ClusterMemoryLive),
      )
      const clusterSupport = Layer.merge(ClusterMemoryLive, entityLive)
      const actorProcessLayer = Layer.provide(ClusterActorProcessLive, clusterSupport)
      return Layer.merge(clusterSupport, actorProcessLayer)
    }
    return Layer.provide(LocalActorProcessLive, storageDeps)
  }

  const makeIntegrationLayer = (
    runLog: Ref.Ref<Array<{ sessionId: string; content: string }>>,
    mode: "local" | "cluster" = "local",
  ) => {
    const agentLoopLayer = Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const log = yield* Effect.succeed(runLog)
        return {
          run: (message: Message) =>
            Ref.update(log, (entries) => [
              ...entries,
              {
                sessionId: message.sessionId,
                content: message.parts
                  .filter((p): p is { type: "text"; text: string } => p.type === "text")
                  .map((p) => p.text)
                  .join(""),
              },
            ]),
          steer: () => Effect.void,
          followUp: () => Effect.void,
          isRunning: () => Effect.succeed(false),
          getState: () =>
            Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
        }
      }),
    )

    const eventStoreLayer = EventStore.Test()
    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      eventStoreLayer,
      agentLoopLayer,
      ToolRunner.Test(),
    )
    const actorProcessLayer = makeActorProcessLayer(storageDeps, mode)
    const baseWithActorProcess = Layer.mergeAll(
      storageDeps,
      actorProcessLayer,
      Provider.Test([]),
      Permission.Live([], "ask"),
      ConfigService.Test(),
    )
    const deps = Layer.mergeAll(
      baseWithActorProcess,
      Layer.provide(PermissionHandler.Live, baseWithActorProcess),
      Layer.provide(PromptHandler.Live, baseWithActorProcess),
      Layer.provide(HandoffHandler.Live, baseWithActorProcess),
    )
    return Layer.provideMerge(AppServicesLive, deps)
  }

  test("createSession with firstMessage reaches AgentLoop.run", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const layer = makeIntegrationLayer(runLog)

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({
          name: "Integration Test",
          firstMessage: "hello from createSession",
        })

        yield* Effect.sleep("50 millis")

        const entries = yield* Ref.get(runLog)
        expect(entries.length).toBe(1)
        expect(entries[0]!.sessionId).toBe(session.sessionId)
        expect(entries[0]!.content).toBe("hello from createSession")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("sendMessage reaches AgentLoop.run through cluster actor", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const layer = makeIntegrationLayer(runLog, "cluster")

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({ name: "Cluster Send Test" })

        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "hello from clustered sendMessage",
        })

        yield* Effect.sleep("50 millis")

        const entries = yield* Ref.get(runLog)
        expect(entries.length).toBe(1)
        expect(entries[0]!.sessionId).toBe(session.sessionId)
        expect(entries[0]!.content).toBe("hello from clustered sendMessage")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("sendMessage reaches AgentLoop.run", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const layer = makeIntegrationLayer(runLog)

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({ name: "Send Test" })

        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "hello from sendMessage",
        })

        yield* Effect.sleep("50 millis")

        const entries = yield* Ref.get(runLog)
        expect(entries.length).toBe(1)
        expect(entries[0]!.sessionId).toBe(session.sessionId)
        expect(entries[0]!.content).toBe("hello from sendMessage")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("steer reaches AgentLoop.steer", async () => {
    let steered = false

    const agentLoopLayer = Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () =>
        Effect.sync(() => {
          steered = true
        }),
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      getState: () => Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
    })

    const eventStoreLayer = EventStore.Test()
    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      eventStoreLayer,
      agentLoopLayer,
      ToolRunner.Test(),
    )
    const actorProcessLayer = Layer.provide(LocalActorProcessLive, storageDeps)
    const baseWithActorProcess = Layer.mergeAll(
      storageDeps,
      actorProcessLayer,
      Provider.Test([]),
      Permission.Live([], "ask"),
      ConfigService.Test(),
    )
    const deps = Layer.mergeAll(
      baseWithActorProcess,
      Layer.provide(PermissionHandler.Live, baseWithActorProcess),
      Layer.provide(PromptHandler.Live, baseWithActorProcess),
      Layer.provide(HandoffHandler.Live, baseWithActorProcess),
    )
    const layer = Layer.provideMerge(AppServicesLive, deps)

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const session = yield* commands.createSession({ name: "Steer Test" })

        yield* commands.steer({
          _tag: "SwitchAgent",
          sessionId: session.sessionId,
          branchId: session.branchId,
          agent: "deepwork",
        })

        expect(steered).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("actor process getState delegates to the loop snapshot", async () => {
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: () => Effect.succeed(true),
      getState: () =>
        Effect.succeed({
          status: "interrupted" as const,
          agent: "deepwork" as const,
          queueDepth: 2,
        }),
    })

    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      EventStore.Test(),
      agentLoopLayer,
      ToolRunner.Test(),
    )
    const layer = Layer.provide(LocalActorProcessLive, storageDeps)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const actorProcess = yield* ActorProcess
        return yield* actorProcess.getState({
          sessionId: "state-session" as SessionId,
          branchId: "state-branch" as BranchId,
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toEqual({
      status: "interrupted",
      agent: "deepwork",
      queueDepth: 2,
      lastError: undefined,
    })
  })

  test("invokeTool works through cluster actor", async () => {
    let toolCalls = 0

    const eventStoreLayer = EventStore.Test()
    const storageLayer = Storage.Test()
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
      getState: () => Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
    })
    const toolRunnerLayer = Layer.succeed(ToolRunner, {
      run: (toolCall) =>
        Effect.succeed(
          new ToolResultPart({
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: { type: "json", value: { ok: true } },
          }),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              toolCalls += 1
            }),
          ),
        ),
    })
    const storageDeps = Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      agentLoopLayer,
      toolRunnerLayer,
    )
    const actorProcessLayer = makeActorProcessLayer(storageDeps, "cluster")
    const layer = Layer.mergeAll(storageDeps, actorProcessLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const actorProcess = yield* ActorProcess

        const session = new Session({
          id: "session-cluster" as SessionId,
          name: "Cluster Invoke Test",
          cwd: process.cwd(),
          bypass: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        const branch = new Branch({
          id: "branch-cluster" as BranchId,
          sessionId: session.id,
          createdAt: new Date(),
        })
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* actorProcess.invokeTool({
          sessionId: session.id,
          branchId: branch.id,
          toolName: "todo_read",
          input: {},
        })

        yield* Effect.sleep("50 millis")

        const messages = yield* storage.listMessages(branch.id)
        expect(toolCalls).toBe(1)
        expect(messages.some((message) => message.role === "assistant")).toBe(true)
        expect(messages.some((message) => message.role === "tool")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })
})

describe("Durable actor inbox", () => {
  const makeDurableActorLayer = (
    runLog: Ref.Ref<Array<{ sessionId: string; content: string }>>,
  ) => {
    const agentLoopLayer = Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const log = yield* Effect.succeed(runLog)
        return {
          run: (message: Message) =>
            Ref.update(log, (entries) => [
              ...entries,
              {
                sessionId: message.sessionId,
                content: message.parts
                  .filter((p): p is { type: "text"; text: string } => p.type === "text")
                  .map((p) => p.text)
                  .join(""),
              },
            ]),
          steer: () => Effect.void,
          followUp: () => Effect.void,
          isRunning: () => Effect.succeed(false),
          getState: () =>
            Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
        }
      }),
    )

    const storageDeps = Layer.mergeAll(
      Storage.Test(),
      EventStore.Test(),
      agentLoopLayer,
      ToolRunner.Test(),
    )
    const actorTransportLayer = Layer.provide(LocalActorTransportLive, storageDeps)
    const actorProcessLayer = Layer.provide(
      DurableActorProcessLive,
      Layer.merge(storageDeps, actorTransportLayer),
    )
    return Layer.mergeAll(storageDeps, actorTransportLayer, actorProcessLayer)
  }

  test("repeating the same command id only dispatches once", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const layer = makeDurableActorLayer(runLog)
    const commandId = "command-dedupe" as ActorCommandId

    await Effect.runPromise(
      Effect.gen(function* () {
        const actorProcess = yield* ActorProcess
        const storage = yield* Storage

        const session = new Session({
          id: "session-dedupe" as SessionId,
          name: "Dedupe Test",
          cwd: process.cwd(),
          bypass: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        const branch = new Branch({
          id: "branch-dedupe" as BranchId,
          sessionId: session.id,
          createdAt: new Date(),
        })
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* actorProcess.sendUserMessage({
          commandId,
          sessionId: session.id,
          branchId: branch.id,
          content: "only once",
        })
        yield* actorProcess.sendUserMessage({
          commandId,
          sessionId: session.id,
          branchId: branch.id,
          content: "only once",
        })

        yield* Effect.sleep("50 millis")

        const entries = yield* Ref.get(runLog)
        const completed = yield* storage.listActorInboxRecordsByStatus(["completed"])
        expect(entries).toEqual([{ sessionId: session.id, content: "only once" }])
        expect(completed.filter((record) => record.commandId === commandId)).toHaveLength(1)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("recovery marks a running command completed when its receipt already exists", async () => {
    const runLog = Ref.makeUnsafe<Array<{ sessionId: string; content: string }>>([])
    const commandId = "command-replay" as ActorCommandId
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-actor-inbox-"))
    const dbPath = path.join(dbDir, "data.db")

    const makeFileBackedLayer = (withDurableActor: boolean) => {
      const agentLoopLayer = Layer.effect(
        AgentLoop,
        Effect.gen(function* () {
          const log = yield* Effect.succeed(runLog)
          return {
            run: (message: Message) =>
              Ref.update(log, (entries) => [
                ...entries,
                {
                  sessionId: message.sessionId,
                  content: message.parts
                    .filter((p): p is { type: "text"; text: string } => p.type === "text")
                    .map((p) => p.text)
                    .join(""),
                },
              ]),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            isRunning: () => Effect.succeed(false),
            getState: () =>
              Effect.succeed({ status: "idle" as const, agent: "cowork", queueDepth: 0 }),
          }
        }),
      )

      const storageDeps = Layer.mergeAll(
        Storage.Live(dbPath),
        EventStore.Test(),
        agentLoopLayer,
        ToolRunner.Test(),
      ).pipe(Layer.provide(BunFileSystem.layer), Layer.provide(BunServices.layer))
      const actorTransportLayer = Layer.provide(LocalActorTransportLive, storageDeps)
      if (!withDurableActor) return Layer.mergeAll(storageDeps, actorTransportLayer)
      const actorProcessLayer = Layer.provide(
        DurableActorProcessLive,
        Layer.merge(storageDeps, actorTransportLayer),
      )
      return Layer.mergeAll(storageDeps, actorTransportLayer, actorProcessLayer)
    }

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage

          const session = new Session({
            id: "session-replay" as SessionId,
            name: "Replay Test",
            cwd: process.cwd(),
            bypass: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          const branch = new Branch({
            id: "branch-replay" as BranchId,
            sessionId: session.id,
            createdAt: new Date(),
          })
          const userMessage = new Message({
            id: commandId as unknown as MessageId,
            sessionId: session.id,
            branchId: branch.id,
            kind: "regular",
            role: "user",
            parts: [new TextPart({ type: "text", text: "already accepted" })],
            createdAt: new Date(),
          })

          yield* storage.createSession(session)
          yield* storage.createBranch(branch)
          yield* storage.createMessageIfAbsent(userMessage)
          yield* storage.createActorInboxRecord({
            commandId,
            sessionId: session.id,
            branchId: branch.id,
            kind: "send-user-message",
            payloadJson: JSON.stringify({
              commandId,
              sessionId: session.id,
              branchId: branch.id,
              content: "already accepted",
            }),
            status: "running",
            attempts: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            startedAt: Date.now(),
          })
        }).pipe(Effect.provide(makeFileBackedLayer(false))),
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const records = yield* storage.listActorInboxRecordsByStatus(["completed"])
          const entries = yield* Ref.get(runLog)

          expect(entries).toHaveLength(0)
          expect(records.some((record) => record.commandId === commandId)).toBe(true)
        }).pipe(Effect.provide(makeFileBackedLayer(true))),
      )
    } finally {
      fs.rmSync(dbDir, { recursive: true, force: true })
    }
  })
})
