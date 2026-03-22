import { describe, test, expect } from "bun:test"
import { Effect, FileSystem, Layer, pipe, type Path, type Scope } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ReadTool } from "@gent/core/tools/read"
import { GlobTool } from "@gent/core/tools/glob"
import { GrepTool } from "@gent/core/tools/grep"
import { TodoReadTool, TodoWriteTool, TodoHandler } from "@gent/core/tools/todo"
import { QuestionTool, QuestionHandler } from "@gent/core/tools/ask-user"
import { PlanTool } from "@gent/core/tools/plan"
import { TaskTool } from "@gent/core/tools/task"
import type { ToolContext } from "@gent/core/domain/tool"
import { AgentRegistry, SubagentRunnerService } from "@gent/core/domain/agent"
import { PlanHandler } from "@gent/core/domain/interaction-handlers"
import { TodoItem } from "@gent/core/domain/todo"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

// Layer providing FileSystem and Path from @effect/platform-bun
const PlatformLayer = BunServices.layer

// Helper to run scoped effects with platform layer
const runScoped = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.runPromise(pipe(effect, Effect.scoped, Effect.provide(PlatformLayer)))

describe("Tools", () => {
  describe("ReadTool", () => {
    test("reads a file", () =>
      runScoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          const testFile = `${tmpDir}/test.txt`
          yield* fs.writeFileString(testFile, "Hello, World!")

          const result = yield* ReadTool.execute({ path: testFile }, ctx)
          expect(result.content).toBe("1\tHello, World!")
        }),
      ))

    test("returns error for non-existent file", () =>
      runScoped(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            ReadTool.execute({ path: "/nonexistent/file.txt" }, ctx),
          )
          expect(result._tag).toBe("Failure")
        }),
      ))

    test("returns error for directory", () =>
      runScoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()

          const result = yield* Effect.result(ReadTool.execute({ path: tmpDir }, ctx))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain("Cannot read directory")
          }
        }),
      ))

    test("rejects .env file with ReadError", () =>
      runScoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          yield* fs.writeFileString(`${tmpDir}/.env`, "SECRET=value")

          const result = yield* Effect.result(ReadTool.execute({ path: `${tmpDir}/.env` }, ctx))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain("Cannot read secret file")
          }
        }),
      ))

    test("allows .env.example", () =>
      runScoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          yield* fs.writeFileString(`${tmpDir}/.env.example`, "KEY=placeholder")

          const result = yield* ReadTool.execute({ path: `${tmpDir}/.env.example` }, ctx)
          expect(result.content).toContain("KEY=placeholder")
        }),
      ))

    test("rejects .env.local", () =>
      runScoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          yield* fs.writeFileString(`${tmpDir}/.env.local`, "SECRET=value")

          const result = yield* Effect.result(
            ReadTool.execute({ path: `${tmpDir}/.env.local` }, ctx),
          )
          expect(result._tag).toBe("Failure")
        }),
      ))
  })

  describe("GlobTool", () => {
    test("finds files matching pattern", () =>
      runScoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          yield* fs.writeFileString(`${tmpDir}/a.ts`, "")
          yield* fs.writeFileString(`${tmpDir}/b.ts`, "")
          yield* fs.writeFileString(`${tmpDir}/c.js`, "")

          const result = yield* GlobTool.execute({ pattern: "*.ts", path: tmpDir }, ctx)
          expect(result.files.length).toBe(2)
          expect(result.files.every((f) => f.endsWith(".ts"))).toBe(true)
        }),
      ))
  })

  describe("GrepTool", () => {
    test("finds pattern in files", () =>
      runScoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = yield* fs.makeTempDirectoryScoped()
          yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
          yield* fs.writeFileString(`${tmpDir}/file2.ts`, "const bar = 2")
          yield* fs.writeFileString(`${tmpDir}/file3.ts`, "const foo = 3")

          const result = yield* GrepTool.execute({ pattern: "foo", path: tmpDir }, ctx)
          expect(result.matches.length).toBe(2)
        }),
      ))
  })
})

describe("Todo Tools", () => {
  const todoLayer = Layer.merge(
    TodoHandler.Test([
      new TodoItem({
        id: "t1",
        content: "First task",
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ]),
    PlatformLayer,
  )

  test("TodoReadTool reads existing todos", async () => {
    const result = await Effect.runPromise(
      TodoReadTool.execute({}, ctx).pipe(Effect.provide(todoLayer)),
    )
    expect(result.todos.length).toBe(1)
    expect(result.todos[0]?.content).toBe("First task")
    expect(result.todos[0]?.status).toBe("pending")
  })

  test("TodoWriteTool replaces todos", async () => {
    const layer = Layer.merge(TodoHandler.Test([]), PlatformLayer)

    const writeResult = await Effect.runPromise(
      TodoWriteTool.execute(
        {
          todos: [
            { content: "New task", status: "in_progress" },
            { content: "Another task", status: "pending", priority: "high" },
          ],
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    )
    expect(writeResult.count).toBe(2)

    const readResult = await Effect.runPromise(
      TodoReadTool.execute({}, ctx).pipe(Effect.provide(layer)),
    )
    expect(readResult.todos.length).toBe(2)
    expect(readResult.todos[0]?.status).toBe("in_progress")
    expect(readResult.todos[1]?.priority).toBe("high")
  })
})

describe("Question Tool", () => {
  test("QuestionTool asks questions and returns answers", async () => {
    const layer = Layer.merge(
      QuestionHandler.Test([["Option A"], ["Option B", "Option C"]]),
      PlatformLayer,
    )

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
        ctx,
      ).pipe(Effect.provide(layer)),
    )

    expect(result.answers.length).toBe(2)
    expect(result.answers[0]).toEqual(["Option A"])
    expect(result.answers[1]).toEqual(["Option B", "Option C"])
  })
})

describe("Plan Tool", () => {
  test("writes plan and returns decision", async () => {
    const layer = Layer.merge(PlanHandler.Test(["confirm"]), PlatformLayer)

    const result = await Effect.runPromise(
      PlanTool.execute({ plan: "## Plan\\n- Step 1" }, ctx).pipe(Effect.provide(layer)),
    )

    expect(result.decision).toBe("confirm")
    expect(result.planPath).toContain(".gent/plans/")
  })
})

describe("Task Tool", () => {
  test("delegates to subagent and returns output", async () => {
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: `${params.agent.name}:${params.prompt}`,
          sessionId: "child-session",
          agentName: params.agent.name,
        }),
    })

    const layer = Layer.mergeAll(runnerLayer, AgentRegistry.Live)

    const result = await Effect.runPromise(
      TaskTool.execute({ agent: "explore", task: "hello" }, ctx).pipe(Effect.provide(layer)),
    )

    expect(result.output).toBe("explore:hello\n\nFull session: session://child-session")
  })

  test("chain mode appends session refs for all steps", async () => {
    let stepIdx = 0
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        const idx = stepIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `step-${idx}`,
          sessionId: `session-${idx}`,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(runnerLayer, AgentRegistry.Live)
    const result = await Effect.runPromise(
      TaskTool.execute(
        {
          chain: [
            { agent: "explore", task: "first" },
            { agent: "explore", task: "second" },
          ],
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    )
    expect(result.output).toContain("Full sessions: session://session-0, session://session-1")
  })

  test("parallel mode appends session refs for successes", async () => {
    let callIdx = 0
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        const idx = callIdx++
        return Effect.succeed({
          _tag: "success" as const,
          text: `result-${idx}`,
          sessionId: `session-${idx}`,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(runnerLayer, AgentRegistry.Live)
    const result = await Effect.runPromise(
      TaskTool.execute(
        {
          tasks: [
            { agent: "explore", task: "a" },
            { agent: "explore", task: "b" },
          ],
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    )
    expect(result.output).toContain("2/2 succeeded")
    expect(result.output).toContain("Full sessions:")
    expect(result.output).toContain("session://session-")
  })
})
