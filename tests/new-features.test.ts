import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import {
  TodoReadTool,
  TodoWriteTool,
  TodoHandler,
  QuestionTool,
  QuestionHandler,
  WebFetchTool,
  PlanEnterTool,
  PlanExitTool,
  PlanModeHandler,
  isToolAllowedInMode,
  PLAN_MODE_TOOLS,
} from "@gent/tools"
import { Storage } from "@gent/storage"
import {
  TodoItem,
  Skills,
  Skill,
  formatSkillsForPrompt,
  AuthStorage,
} from "@gent/core"
import {
  isRetryable,
  getRetryDelay,
  DEFAULT_RETRY_CONFIG,
  pruneToolOutputs,
  estimateTokens,
  DEFAULT_COMPACTION_CONFIG,
} from "@gent/runtime"
import { ProviderError, TextChunk, FinishChunk } from "@gent/providers"
import type { ToolContext } from "@gent/core"
import { Message, TextPart, ToolResultPart } from "@gent/core"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

describe("Todo Tools", () => {
  const todoLayer = TodoHandler.Test([
    new TodoItem({
      id: "t1",
      content: "First task",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  ])

  test("TodoReadTool reads existing todos", async () => {
    const result = await Effect.runPromise(
      TodoReadTool.execute({}, ctx).pipe(Effect.provide(todoLayer))
    )
    expect(result.todos.length).toBe(1)
    expect(result.todos[0]?.content).toBe("First task")
    expect(result.todos[0]?.status).toBe("pending")
  })

  test("TodoWriteTool replaces todos", async () => {
    const layer = TodoHandler.Test([])

    const writeResult = await Effect.runPromise(
      TodoWriteTool.execute(
        {
          todos: [
            { content: "New task", status: "in_progress" },
            { content: "Another task", status: "pending", priority: "high" },
          ],
        },
        ctx
      ).pipe(Effect.provide(layer))
    )
    expect(writeResult.count).toBe(2)

    const readResult = await Effect.runPromise(
      TodoReadTool.execute({}, ctx).pipe(Effect.provide(layer))
    )
    expect(readResult.todos.length).toBe(2)
    expect(readResult.todos[0]?.status).toBe("in_progress")
    expect(readResult.todos[1]?.priority).toBe("high")
  })
})

describe("Question Tool", () => {
  test("QuestionTool asks questions and returns answers", async () => {
    const layer = QuestionHandler.Test([["Option A"], ["Option B", "Option C"]])

    const result = await Effect.runPromise(
      QuestionTool.execute(
        {
          questions: [
            {
              question: "Which approach?",
              header: "Approach",
              options: [
                { label: "Option A", description: "First option" },
                { label: "Option B", description: "Second option" },
              ],
            },
            {
              question: "Which features?",
              header: "Features",
              options: [
                { label: "Option B", description: "Feature B" },
                { label: "Option C", description: "Feature C" },
              ],
              multiple: true,
            },
          ],
        },
        ctx
      ).pipe(Effect.provide(layer))
    )

    expect(result.answers.length).toBe(2)
    expect(result.answers[0]).toEqual(["Option A"])
    expect(result.answers[1]).toEqual(["Option B", "Option C"])
  })
})

describe("Retry Logic", () => {
  test("isRetryable detects rate limits", () => {
    const rateLimitError = new ProviderError({
      message: "Rate limit exceeded (429)",
      model: "test",
    })
    expect(isRetryable(rateLimitError)).toBe(true)
  })

  test("isRetryable detects overload", () => {
    const overloadError = new ProviderError({
      message: "Service overloaded",
      model: "test",
    })
    expect(isRetryable(overloadError)).toBe(true)
  })

  test("isRetryable detects 500 errors", () => {
    const serverError = new ProviderError({
      message: "Internal server error 500",
      model: "test",
    })
    expect(isRetryable(serverError)).toBe(true)
  })

  test("isRetryable returns false for non-retryable errors", () => {
    const authError = new ProviderError({
      message: "Invalid API key",
      model: "test",
    })
    expect(isRetryable(authError)).toBe(false)
  })

  test("getRetryDelay uses exponential backoff", () => {
    const delay0 = getRetryDelay(0, null)
    const delay1 = getRetryDelay(1, null)
    const delay2 = getRetryDelay(2, null)

    expect(delay0).toBe(DEFAULT_RETRY_CONFIG.initialDelay)
    expect(delay1).toBe(DEFAULT_RETRY_CONFIG.initialDelay * 2)
    expect(delay2).toBe(DEFAULT_RETRY_CONFIG.initialDelay * 4)
  })

  test("getRetryDelay respects maxDelay", () => {
    const delay = getRetryDelay(10, null)
    expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_CONFIG.maxDelay)
  })
})

describe("Skills System", () => {
  test("Skills.Test provides test skills", async () => {
    const testSkills = [
      new Skill({
        name: "test-skill",
        description: "A test skill",
        filePath: "/test/skill.md",
        content: "# Test Skill\n\nContent here",
      }),
    ]

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const skills = yield* Skills
        return yield* skills.list()
      }).pipe(Effect.provide(Skills.Test(testSkills)))
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
      }),
      new Skill({
        name: "skill2",
        description: "Second skill",
        filePath: "/s2.md",
        content: "",
      }),
    ]

    const formatted = formatSkillsForPrompt(skills)
    expect(formatted).toContain("<available_skills>")
    expect(formatted).toContain("**skill1**")
    expect(formatted).toContain("**skill2**")
  })

  test("formatSkillsForPrompt returns empty for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("")
  })
})

describe("Compaction", () => {
  test("estimateTokens calculates token count", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "user",
        parts: [new TextPart({ type: "text", text: "Hello world" })], // 11 chars
        createdAt: new Date(),
      }),
    ]

    const tokens = estimateTokens(messages)
    expect(tokens).toBe(3) // ceil(11/4) = 3
  })

  test("pruneToolOutputs preserves recent outputs", () => {
    const messages = [
      new Message({
        id: "m1",
        sessionId: "s",
        branchId: "b",
        role: "tool",
        parts: [
          new ToolResultPart({
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test",
            output: { type: "json", value: { data: "x".repeat(1000) } },
          }),
        ],
        createdAt: new Date(),
      }),
    ]

    // With high pruneProtect, nothing should be pruned
    const config = { ...DEFAULT_COMPACTION_CONFIG, pruneProtect: 100000 }
    const result = pruneToolOutputs(messages, config)
    expect(result.length).toBe(1)
    expect(
      (result[0]?.parts[0] as ToolResultPart).output.value
    ).not.toHaveProperty("_pruned")
  })
})

describe("Auth Storage", () => {
  test("AuthStorage.Test stores and retrieves keys", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStorage
        yield* auth.set("anthropic", "test-key-123")
        return yield* auth.get("anthropic")
      }).pipe(Effect.provide(AuthStorage.Test()))
    )

    expect(result).toBe("test-key-123")
  })

  test("AuthStorage.Test deletes keys", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStorage
        yield* auth.set("openai", "key")
        yield* auth.delete("openai")
        return yield* auth.get("openai")
      }).pipe(Effect.provide(AuthStorage.Test()))
    )

    expect(result).toBeUndefined()
  })

  test("AuthStorage.Test lists providers", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStorage
        yield* auth.set("anthropic", "k1")
        yield* auth.set("openai", "k2")
        return yield* auth.list()
      }).pipe(Effect.provide(AuthStorage.Test()))
    )

    expect(result).toContain("anthropic")
    expect(result).toContain("openai")
  })
})

describe("Plan Mode", () => {
  test("PlanEnterTool switches to plan mode", async () => {
    const layer = PlanModeHandler.Test("build", [true])

    const result = await Effect.runPromise(
      PlanEnterTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("plan")
    expect(result.message).toContain("plan mode")
  })

  test("PlanEnterTool respects user declining", async () => {
    const layer = PlanModeHandler.Test("build", [false])

    const result = await Effect.runPromise(
      PlanEnterTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("build")
    expect(result.message).toContain("declined")
  })

  test("PlanExitTool switches to build mode", async () => {
    const layer = PlanModeHandler.Test("plan", [true])

    const result = await Effect.runPromise(
      PlanExitTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("build")
    expect(result.message).toContain("build mode")
  })

  test("isToolAllowedInMode allows all tools in build mode", () => {
    expect(isToolAllowedInMode("write", "build")).toBe(true)
    expect(isToolAllowedInMode("bash", "build")).toBe(true)
    expect(isToolAllowedInMode("edit", "build")).toBe(true)
  })

  test("isToolAllowedInMode restricts tools in plan mode", () => {
    expect(isToolAllowedInMode("read", "plan")).toBe(true)
    expect(isToolAllowedInMode("grep", "plan")).toBe(true)
    expect(isToolAllowedInMode("glob", "plan")).toBe(true)
    expect(isToolAllowedInMode("webfetch", "plan")).toBe(true)
    expect(isToolAllowedInMode("question", "plan")).toBe(true)

    expect(isToolAllowedInMode("write", "plan")).toBe(false)
    expect(isToolAllowedInMode("edit", "plan")).toBe(false)
    expect(isToolAllowedInMode("bash", "plan")).toBe(false)
  })

  test("PLAN_MODE_TOOLS contains expected tools", () => {
    expect(PLAN_MODE_TOOLS).toContain("read")
    expect(PLAN_MODE_TOOLS).toContain("grep")
    expect(PLAN_MODE_TOOLS).toContain("glob")
    expect(PLAN_MODE_TOOLS).toContain("webfetch")
    expect(PLAN_MODE_TOOLS).toContain("plan_exit")
  })
})

describe("Storage - Todos", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, Storage>) =>
    Effect.runPromise(Effect.provide(effect, Storage.Test()))

  test("listTodos returns empty for new branch", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const todos = yield* storage.listTodos("nonexistent")
        expect(todos.length).toBe(0)
      })
    )
  })

  test("replaceTodos stores and retrieves todos", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const now = new Date()

        const todos = [
          new TodoItem({
            id: "t1",
            content: "Task 1",
            status: "pending",
            priority: "high",
            createdAt: now,
            updatedAt: now,
          }),
          new TodoItem({
            id: "t2",
            content: "Task 2",
            status: "in_progress",
            createdAt: now,
            updatedAt: now,
          }),
        ]

        yield* storage.replaceTodos("test-branch", todos)
        const retrieved = yield* storage.listTodos("test-branch")

        expect(retrieved.length).toBe(2)
        expect(retrieved[0]?.content).toBe("Task 1")
        expect(retrieved[0]?.priority).toBe("high")
        expect(retrieved[1]?.status).toBe("in_progress")
      })
    )
  })

  test("replaceTodos replaces existing todos", async () => {
    await run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const now = new Date()

        yield* storage.replaceTodos("branch", [
          new TodoItem({
            id: "old",
            content: "Old",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          }),
        ])

        yield* storage.replaceTodos("branch", [
          new TodoItem({
            id: "new",
            content: "New",
            status: "completed",
            createdAt: now,
            updatedAt: now,
          }),
        ])

        const todos = yield* storage.listTodos("branch")
        expect(todos.length).toBe(1)
        expect(todos[0]?.content).toBe("New")
      })
    )
  })
})
