import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
import type { SessionId } from "@gent/core/domain/ids"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { Provider } from "@gent/core/providers/provider"
import { AppServicesLive } from "@gent/core/server/index"
import { SessionQueries } from "@gent/core/server/session-queries"
import { SessionCommands } from "@gent/core/server/session-commands"
import { ActorProcess } from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
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

describe("Session Snapshot", () => {
  test("getSessionSnapshot only returns persisted state", async () => {
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
      Storage.Test(),
      Provider.Test([]),
      eventStoreLayer,
      actorProcessLayer,

      Permission.Live([], "ask"),
      ConfigService.Test(),
    )
    const deps = Layer.mergeAll(
      baseWithEventStore,
      AgentLoop.Test(),
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
            fromAgent: "deepwork",
            toAgent: "cowork",
          }),
        )

        return yield* queries.getSessionSnapshot({
          sessionId: session.sessionId,
          branchId: session.branchId,
        })
      }).pipe(Effect.provide(testLayer)),
    )

    expect(result.sessionId).toBeDefined()
    expect(result.messages).toEqual([])
    expect(result.bypass).toBe(true)
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
      AgentLoop.Test(),
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
