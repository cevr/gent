import { describe, test, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Skills, Skill, formatSkillsForPrompt } from "@gent/core/domain/skills"
import { AuthApi, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import { calculateCost } from "@gent/core/domain/model"
import { EventStore, AgentSwitched } from "@gent/core/domain/event"
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
import { SessionQueries } from "@gent/core/server/session-queries"
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

describe("Skills System", () => {
  test("Skills.Test provides test skills", async () => {
    const testSkills = [
      new Skill({
        name: "test-skill",
        description: "A test skill",
        filePath: "/test/skill.md",
        content: "# Test Skill\n\nContent here",
        scope: "global",
      }),
    ]

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const skills = yield* Skills
        return yield* skills.list()
      }).pipe(Effect.provide(Skills.Test(testSkills))),
    )

    expect(result.length).toBe(1)
    expect(result[0]?.name).toBe("test-skill")
  })

  test("formatSkillsForPrompt formats skills correctly", () => {
    const skills = [
      new Skill({
        name: "skill1",
        description: "First skill",
        filePath: "/s1.md",
        content: "",
        scope: "global",
      }),
      new Skill({
        name: "skill2",
        description: "Second skill",
        filePath: "/s2.md",
        content: "",
        scope: "project",
      }),
    ]

    const formatted = formatSkillsForPrompt(skills)
    expect(formatted).toContain("<available_skills>")
    expect(formatted).toContain("**skill1**")
    expect(formatted).toContain("**skill2**")
  })

  test("formatSkillsForPrompt qualifies names on collision", () => {
    const skills = [
      new Skill({
        name: "deploy",
        description: "Project deploy",
        filePath: "/proj/.gent/skills/deploy.md",
        content: "",
        scope: "project",
      }),
      new Skill({
        name: "deploy",
        description: "Global deploy",
        filePath: "/home/.gent/skills/deploy.md",
        content: "",
        scope: "global",
      }),
    ]

    const formatted = formatSkillsForPrompt(skills)
    expect(formatted).toContain("**deploy (project)**")
    expect(formatted).toContain("**deploy (global)**")
  })

  test("formatSkillsForPrompt returns empty for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("")
  })
})

describe("Auth Store", () => {
  test("AuthStore stores and retrieves keys", async () => {
    const layer = Layer.provide(AuthStore.Live, AuthStorage.Test())
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.set("anthropic", new AuthApi({ type: "api", key: "test-key-123" }))
        return yield* auth.get("anthropic")
      }).pipe(Effect.provide(layer)),
    )

    expect(result?.type).toBe("api")
  })

  test("AuthStore deletes keys", async () => {
    const layer = Layer.provide(AuthStore.Live, AuthStorage.Test())
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.set("openai", new AuthApi({ type: "api", key: "key" }))
        yield* auth.remove("openai")
        return yield* auth.get("openai")
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toBeUndefined()
  })

  test("AuthStore lists providers", async () => {
    const layer = Layer.provide(AuthStore.Live, AuthStorage.Test())
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        yield* auth.set("anthropic", new AuthApi({ type: "api", key: "k1" }))
        yield* auth.set("openai", new AuthApi({ type: "api", key: "k2" }))
        return yield* auth.list()
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toContain("anthropic")
    expect(result).toContain("openai")
  })
})

describe("Cost Calculation", () => {
  test("calculateCost computes correctly", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    const pricing = { input: 3, output: 15 } // $3/1M input, $15/1M output

    const cost = calculateCost(usage, pricing)
    // (1000 / 1M) * 3 + (500 / 1M) * 15 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6)
  })

  test("calculateCost returns 0 without pricing", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    expect(calculateCost(usage, undefined)).toBe(0)
  })

  test("calculateCost handles large token counts", () => {
    const usage = { inputTokens: 100000, outputTokens: 50000 }
    const pricing = { input: 3, output: 15 }

    const cost = calculateCost(usage, pricing)
    // (100000 / 1M) * 3 + (50000 / 1M) * 15 = 0.3 + 0.75 = 1.05
    expect(cost).toBeCloseTo(1.05, 6)
  })
})

describe("Session State", () => {
  test("getSessionState returns latest agent switch", async () => {
    const eventStoreLayer = EventStore.Test()
    const baseWithEventStore = Layer.mergeAll(
      Storage.Test(),
      Provider.Test([]),
      eventStoreLayer,
      ActorProcess.Test(),

      Permission.Live([], "ask"),
      ConfigService.Test(),
    )
    const deps = Layer.mergeAll(
      baseWithEventStore,
      Layer.provide(PermissionHandler.Live, baseWithEventStore),
      Layer.provide(PromptHandler.Live, baseWithEventStore),
      Layer.provide(HandoffHandler.Live, baseWithEventStore),
    )
    const testLayer = Layer.provideMerge(AppServicesLive, deps)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const queries = yield* SessionQueries
        const storage = yield* Storage
        const session = yield* commands.createSession({ name: "Test Session" })

        yield* storage.appendEvent(
          new AgentSwitched({
            sessionId: session.sessionId,
            branchId: session.branchId,
            fromAgent: "cowork",
            toAgent: "deepwork",
          }),
        )

        return yield* queries.getSessionState({
          sessionId: session.sessionId,
          branchId: session.branchId,
        })
      }).pipe(Effect.provide(testLayer)),
    )

    expect(result.agent).toBe("deepwork")
  })
})

describe("Session Tree", () => {
  const makeTestLayer = () => {
    const eventStoreLayer = EventStore.Test()
    const baseWithEventStore = Layer.mergeAll(
      Storage.Test(),
      Provider.Test([]),
      eventStoreLayer,
      ActorProcess.Test(),

      Permission.Live([], "ask"),
      ConfigService.Test(),
    )
    const deps = Layer.mergeAll(
      baseWithEventStore,
      Layer.provide(PermissionHandler.Live, baseWithEventStore),
      Layer.provide(PromptHandler.Live, baseWithEventStore),
      Layer.provide(HandoffHandler.Live, baseWithEventStore),
    )
    return Layer.provideMerge(AppServicesLive, deps)
  }

  test("getChildSessions returns direct children", async () => {
    const testLayer = makeTestLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
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
        return yield* queries.getChildSessions(parent.sessionId)
      }).pipe(Effect.provide(testLayer)),
    )

    expect(result.length).toBe(2)
  })

  test("getSessionTree builds recursive hierarchy", async () => {
    const testLayer = makeTestLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
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
        return yield* queries.getSessionTree(root.sessionId)
      }).pipe(Effect.provide(testLayer)),
    )

    expect(result.session.name).toBe("Root")
    expect(result.children.length).toBe(1)
    expect(result.children[0]!.session.name).toBe("Child")
    expect(result.children[0]!.children.length).toBe(1)
    expect(result.children[0]!.children[0]!.session.name).toBe("Grandchild")
  })

  test("createSession rejects invalid parentSessionId", async () => {
    const testLayer = makeTestLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        return yield* Effect.result(
          commands.createSession({
            name: "Orphan",
            parentSessionId: "nonexistent" as SessionId,
          }),
        )
      }).pipe(Effect.provide(testLayer)),
    )

    expect(result._tag).toBe("Failure")
  })

  test("createSession threads parentSessionId to storage", async () => {
    const testLayer = makeTestLayer()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const queries = yield* SessionQueries
        const parent = yield* commands.createSession({ name: "Parent" })
        const child = yield* commands.createSession({
          name: "Child",
          parentSessionId: parent.sessionId,
          parentBranchId: parent.branchId,
        })
        return yield* queries.getSession(child.sessionId)
      }).pipe(Effect.provide(testLayer)),
    )

    expect(result).not.toBeNull()
    expect(result!.parentSessionId).toBeDefined()
  })
})

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

        // Give forked fiber time to execute
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

        // Give forked fiber time to execute
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

  test("invokeTool works through cluster actor", async () => {
    let toolCalls = 0

    const eventStoreLayer = EventStore.Test()
    const storageLayer = Storage.Test()
    const agentLoopLayer = Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
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
