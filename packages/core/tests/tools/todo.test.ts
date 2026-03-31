import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { TodoReadTool, TodoWriteTool, TodoHandler } from "@gent/core/tools/todo"
import type { ToolContext } from "@gent/core/domain/tool"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { TodoItem } from "@gent/core/domain/todo"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimePlatform.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
)

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
