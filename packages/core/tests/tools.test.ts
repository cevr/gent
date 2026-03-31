import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Fiber, FileSystem, Layer, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ReadTool } from "@gent/core/tools/read"
import { GlobTool } from "@gent/core/tools/glob"
import { GrepTool } from "@gent/core/tools/grep"
import { TodoReadTool, TodoWriteTool, TodoHandler } from "@gent/core/tools/todo"
import { AskUserTool, AskUserHandler } from "@gent/core/tools/ask-user"
import { PromptTool } from "@gent/core/tools/prompt"
import { DelegateTool } from "@gent/core/tools/delegate"
import type { ToolContext } from "@gent/core/domain/tool"
import { EventStore } from "@gent/core/domain/event"
import { Agents, SubagentRunnerService } from "@gent/core/domain/agent"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { Storage } from "@gent/core/storage/sqlite-storage"

const TestExtRegistry = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin",
      sourcePath: "test",
      setup: { agents: Object.values(Agents) },
    },
  ]),
)
import { PromptPresenter } from "@gent/core/domain/prompt-presenter"
import { TodoItem } from "@gent/core/domain/todo"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const RuntimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

// Layer providing FileSystem and Path from @effect/platform-bun
const PlatformLayer = Layer.merge(BunServices.layer, RuntimePlatformLayer)

describe("Tools", () => {
  describe("ReadTool", () => {
    const readTest = it.scopedLive.layer(PlatformLayer)

    readTest("reads a file", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        const testFile = `${tmpDir}/test.txt`
        yield* fs.writeFileString(testFile, "Hello, World!")

        const result = yield* ReadTool.execute({ path: testFile }, ctx)
        expect(result.content).toBe("1\tHello, World!")
      }),
    )

    readTest("returns error for non-existent file", () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          ReadTool.execute({ path: "/nonexistent/file.txt" }, ctx),
        )
        expect(result._tag).toBe("Failure")
      }),
    )

    readTest("returns error for directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()

        const result = yield* Effect.result(ReadTool.execute({ path: tmpDir }, ctx))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure.message).toContain("Cannot read directory")
        }
      }),
    )
  })

  describe("GlobTool", () => {
    it.scopedLive("finds files matching pattern", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${tmpDir}/a.ts`, "")
        yield* fs.writeFileString(`${tmpDir}/b.ts`, "")
        yield* fs.writeFileString(`${tmpDir}/c.js`, "")

        const result = yield* GlobTool.execute({ pattern: "*.ts", path: tmpDir }, ctx)
        expect(result.files.length).toBe(2)
        expect(result.files.every((f) => f.endsWith(".ts"))).toBe(true)
      }).pipe(Effect.provide(PlatformLayer)),
    )
  })

  describe("GrepTool", () => {
    it.scopedLive("finds pattern in files", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(`${tmpDir}/file1.ts`, "const foo = 1")
        yield* fs.writeFileString(`${tmpDir}/file2.ts`, "const bar = 2")
        yield* fs.writeFileString(`${tmpDir}/file3.ts`, "const foo = 3")

        const result = yield* GrepTool.execute({ pattern: "foo", path: tmpDir }, ctx)
        expect(result.matches.length).toBe(2)
      }).pipe(Effect.provide(PlatformLayer)),
    )
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

  it.live("TodoReadTool reads existing todos", () =>
    TodoReadTool.execute({}, ctx).pipe(
      Effect.map((result) => {
        expect(result.todos.length).toBe(1)
        expect(result.todos[0]?.content).toBe("First task")
        expect(result.todos[0]?.status).toBe("pending")
      }),
      Effect.provide(todoLayer),
    ),
  )

  it.live("TodoWriteTool replaces todos", () => {
    const layer = Layer.merge(TodoHandler.Test([]), PlatformLayer)

    return Effect.gen(function* () {
      const writeResult = yield* TodoWriteTool.execute(
        {
          todos: [
            { content: "New task", status: "in_progress" },
            { content: "Another task", status: "pending", priority: "high" },
          ],
        },
        ctx,
      )
      expect(writeResult.count).toBe(2)

      const readResult = yield* TodoReadTool.execute({}, ctx)
      expect(readResult.todos.length).toBe(2)
      expect(readResult.todos[0]?.status).toBe("in_progress")
      expect(readResult.todos[1]?.priority).toBe("high")
    }).pipe(Effect.provide(layer))
  })
})

describe("AskUser Handler (integration)", () => {
  const deps = Layer.mergeAll(EventStore.Memory, Storage.TestWithSql())
  const handlerLayer = AskUserHandler.Live.pipe(Layer.provideMerge(deps))

  it.scopedLive("respond with cancelled resolves askMany as cancelled", () =>
    Effect.gen(function* () {
      const handler = yield* AskUserHandler
      const eventStore = yield* EventStore

      // Latch: deterministic wait for QuestionsAsked event
      const latch = yield* Deferred.make<string>()
      const subscription = eventStore.subscribe({ sessionId: "test-session" as never }).pipe(
        Stream.tap((env) => {
          if (env.event._tag === "QuestionsAsked") {
            return Deferred.succeed(latch, env.event.requestId)
          }
          return Effect.void
        }),
        Stream.runDrain,
      )
      yield* Effect.forkScoped(subscription)

      // Start askMany in a fiber — it blocks on the deferred
      const askFiber = yield* Effect.forkScoped(handler.askMany([{ question: "Continue?" }], ctx))

      // Wait for event deterministically, then respond
      const requestId = yield* Deferred.await(latch)
      yield* handler.respond(requestId, [], true)

      const decision = yield* Fiber.join(askFiber)
      expect(decision._tag).toBe("cancelled")
    }).pipe(Effect.provide(handlerLayer)),
  )

  it.scopedLive("respond with answers resolves askMany as answered", () =>
    Effect.gen(function* () {
      const handler = yield* AskUserHandler
      const eventStore = yield* EventStore

      const latch = yield* Deferred.make<string>()
      const subscription = eventStore.subscribe({ sessionId: "test-session" as never }).pipe(
        Stream.tap((env) => {
          if (env.event._tag === "QuestionsAsked") {
            return Deferred.succeed(latch, env.event.requestId)
          }
          return Effect.void
        }),
        Stream.runDrain,
      )
      yield* Effect.forkScoped(subscription)

      const askFiber = yield* Effect.forkScoped(handler.askMany([{ question: "Continue?" }], ctx))

      const requestId = yield* Deferred.await(latch)
      yield* handler.respond(requestId, [["Yes"]])

      const decision = yield* Fiber.join(askFiber)
      expect(decision._tag).toBe("answered")
      if (decision._tag === "answered") {
        expect(decision.answers).toEqual([["Yes"]])
      }
    }).pipe(Effect.provide(handlerLayer)),
  )
})

describe("AskUser Tool", () => {
  it.live("asks questions and returns answers", () => {
    const layer = Layer.merge(
      AskUserHandler.Test([["Option A"], ["Option B", "Option C"]]),
      PlatformLayer,
    )

    return AskUserTool.execute(
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
    ).pipe(
      Effect.map((result) => {
        expect(result.answers.length).toBe(2)
        expect(result.answers[0]).toEqual(["Option A"])
        expect(result.answers[1]).toEqual(["Option B", "Option C"])
        expect(result.cancelled).toBeUndefined()
      }),
      Effect.provide(layer),
    )
  })

  it.live("cancel returns cancelled flag with empty answers", () => {
    const layer = Layer.merge(AskUserHandler.TestCancelled(), PlatformLayer)

    return AskUserTool.execute(
      {
        questions: [
          {
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.cancelled).toBe(true)
        expect(result.answers).toEqual([])
      }),
      Effect.provide(layer),
    )
  })
})

describe("Prompt Tool", () => {
  it.live("review mode: writes content and returns decision", () => {
    const layer = Layer.merge(PromptPresenter.Test([], ["yes"]), PlatformLayer)

    return PromptTool.execute({ mode: "review", content: "## Plan\\n- Step 1" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("review")
        if (result.mode === "review") {
          expect(result.decision).toBe("yes")
          expect(result.path).toBe("/tmp/test-prompt.md")
        }
      }),
      Effect.provide(layer),
    )
  })

  it.live("confirm mode: returns yes/no decision", () => {
    const layer = Layer.merge(PromptPresenter.Test(["no"]), PlatformLayer)

    return PromptTool.execute({ mode: "confirm", content: "Proceed?" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("confirm")
        if (result.mode === "confirm") {
          expect(result.decision).toBe("no")
        }
      }),
      Effect.provide(layer),
    )
  })

  it.live("present mode: returns shown status", () => {
    const layer = Layer.merge(PromptPresenter.Test(), PlatformLayer)

    return PromptTool.execute({ mode: "present", content: "Info" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("present")
        if (result.mode === "present") {
          expect(result.status).toBe("shown")
        }
      }),
      Effect.provide(layer),
    )
  })
})

describe("Delegate Tool", () => {
  it.live("delegates to subagent and returns output", () => {
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) =>
        Effect.succeed({
          _tag: "success" as const,
          text: `${params.agent.name}:${params.prompt}`,
          sessionId: "child-session",
          agentName: params.agent.name,
        }),
    })

    const layer = Layer.mergeAll(runnerLayer, TestExtRegistry, RuntimePlatformLayer)

    return DelegateTool.execute({ agent: "explore", task: "hello" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.output).toBe("explore:hello\n\nFull session: session://child-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("chain mode appends session refs for all steps", () => {
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
    const layer = Layer.mergeAll(runnerLayer, TestExtRegistry, RuntimePlatformLayer)
    return DelegateTool.execute(
      {
        chain: [
          { agent: "explore", task: "first" },
          { agent: "explore", task: "second" },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.output).toContain("Full sessions: session://session-0, session://session-1")
      }),
      Effect.provide(layer),
    )
  })

  it.live("parallel mode appends session refs for successes", () => {
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
    const layer = Layer.mergeAll(runnerLayer, TestExtRegistry, RuntimePlatformLayer)
    return DelegateTool.execute(
      {
        tasks: [
          { agent: "explore", task: "a" },
          { agent: "explore", task: "b" },
        ],
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.output).toContain("2/2 succeeded")
        expect(result.output).toContain("Full sessions:")
        expect(result.output).toContain("session://session-")
      }),
      Effect.provide(layer),
    )
  })
})
