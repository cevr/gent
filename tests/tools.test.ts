import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BunContext } from "@effect/platform-bun"
import {
  ReadTool,
  GlobTool,
  GrepTool,
  TodoReadTool,
  TodoWriteTool,
  TodoHandler,
  QuestionTool,
  QuestionHandler,
} from "@gent/tools"
import type { ToolContext } from "@gent/core"
import { TodoItem } from "@gent/core"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

// Layer providing FileSystem and Path from @effect/platform-bun
const PlatformLayer = BunContext.layer

describe("Tools", () => {
  describe("ReadTool", () => {
    test("reads a file", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-test-"))
      const testFile = path.join(tmpDir, "test.txt")
      fs.writeFileSync(testFile, "Hello, World!")

      try {
        const result = await Effect.runPromise(
          ReadTool.execute({ path: testFile }, ctx).pipe(Effect.provide(PlatformLayer)),
        )
        expect(result.content).toBe("1\tHello, World!")
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test("returns error for non-existent file", async () => {
      const result = await Effect.runPromise(
        Effect.either(ReadTool.execute({ path: "/nonexistent/file.txt" }, ctx)).pipe(
          Effect.provide(PlatformLayer),
        ),
      )
      expect(result._tag).toBe("Left")
    })
  })

  describe("GlobTool", () => {
    test("finds files matching pattern", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-glob-"))
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "")
      fs.writeFileSync(path.join(tmpDir, "b.ts"), "")
      fs.writeFileSync(path.join(tmpDir, "c.js"), "")

      try {
        const result = await Effect.runPromise(
          GlobTool.execute({ pattern: "*.ts", path: tmpDir }, ctx).pipe(
            Effect.provide(PlatformLayer),
          ),
        )
        expect(result.files.length).toBe(2)
        expect(result.files.every((f) => f.endsWith(".ts"))).toBe(true)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })

  describe("GrepTool", () => {
    test("finds pattern in files", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-grep-"))
      fs.writeFileSync(path.join(tmpDir, "file1.ts"), "const foo = 1")
      fs.writeFileSync(path.join(tmpDir, "file2.ts"), "const bar = 2")
      fs.writeFileSync(path.join(tmpDir, "file3.ts"), "const foo = 3")

      try {
        const result = await Effect.runPromise(
          GrepTool.execute({ pattern: "foo", path: tmpDir }, ctx).pipe(
            Effect.provide(PlatformLayer),
          ),
        )
        expect(result.matches.length).toBe(2)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
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
