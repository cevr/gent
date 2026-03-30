import { describe, it, expect, test } from "effect-bun-test"
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
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import { Provider } from "@gent/core/providers/provider"
import { AppServicesLive } from "@gent/core/server/index"
import { SessionQueries } from "@gent/core/server/session-queries"
import { SessionCommands } from "@gent/core/server/session-commands"
import { ActorProcess } from "@gent/core/runtime/actor-process"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"

describe("Skills System", () => {
  it.live("Skills.Test provides test skills", () => {
    const testSkills = [
      new Skill({
        name: "test-skill",
        description: "A test skill",
        filePath: "/test/skill.md",
        content: "# Test Skill\n\nContent here",
        scope: "global",
      }),
    ]

    return Effect.gen(function* () {
      const skills = yield* Skills
      const result = yield* skills.list()
      expect(result.length).toBe(1)
      expect(result[0]?.name).toBe("test-skill")
    }).pipe(Effect.provide(Skills.Test(testSkills)))
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
  const authTest = it.live.layer(Layer.provide(AuthStore.Live, AuthStorage.Test()))

  authTest("AuthStore stores and retrieves keys", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("anthropic", new AuthApi({ type: "api", key: "test-key-123" }))
      const result = yield* auth.get("anthropic")
      expect(result?.type).toBe("api")
    }),
  )

  authTest("AuthStore deletes keys", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("openai", new AuthApi({ type: "api", key: "key" }))
      yield* auth.remove("openai")
      const result = yield* auth.get("openai")
      expect(result).toBeUndefined()
    }),
  )

  authTest("AuthStore lists providers", () =>
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* auth.set("anthropic", new AuthApi({ type: "api", key: "k1" }))
      yield* auth.set("openai", new AuthApi({ type: "api", key: "k2" }))
      const result = yield* auth.list()
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
    }),
  )
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
    const storageLayer = Storage.TestWithSql()
    const baseWithEventStore = Layer.mergeAll(
      storageLayer,
      Layer.provide(InteractionStorage.Live, storageLayer),
      Provider.Test([]),
      eventStoreLayer,
      actorProcessLayer,
      ExtensionStateRuntime.Test(),
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
      expect(result.bypass).toBe(true)
    }).pipe(Effect.provide(testLayer))
  })
})

describe("Session Tree", () => {
  const makeTestLayer = () => {
    const eventStoreLayer = EventStore.Test()
    const storageLayer = Storage.TestWithSql()
    const baseWithEventStore = Layer.mergeAll(
      storageLayer,
      Layer.provide(InteractionStorage.Live, storageLayer),
      Provider.Test([]),
      eventStoreLayer,
      ActorProcess.Test(),
      ExtensionStateRuntime.Test(),
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
          parentSessionId: "nonexistent" as SessionId,
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
