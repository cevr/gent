import { Context, Effect, Layer, Schema } from "effect"
import { defineTool, TodoStatus, TodoPriority, TodoItem } from "@gent/core"

// Todo Handler Service - provides storage access

export interface TodoHandlerService {
  readonly list: () => Effect.Effect<ReadonlyArray<TodoItem>>
  readonly replace: (todos: ReadonlyArray<TodoItem>) => Effect.Effect<void>
}

export class TodoHandler extends Context.Tag("@gent/tools/src/todo/TodoHandler")<
  TodoHandler,
  TodoHandlerService
>() {
  static Test = (initialTodos: ReadonlyArray<TodoItem> = []): Layer.Layer<TodoHandler> => {
    let todos = [...initialTodos]
    return Layer.succeed(TodoHandler, {
      list: () => Effect.succeed(todos),
      replace: (newTodos) =>
        Effect.sync(() => {
          todos = [...newTodos]
        }),
    })
  }
}

// TodoRead Params & Result
// Note: needs at least one property for Bedrock JSON schema compatibility

export const TodoReadParams = Schema.Struct({
  _dummy: Schema.optional(Schema.Undefined),
})

export const TodoReadResult = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      content: Schema.String,
      status: TodoStatus,
      priority: Schema.optional(TodoPriority),
    }),
  ),
})

// TodoRead Tool

export const TodoReadTool = defineTool({
  name: "todo_read",
  concurrency: "serial",
  description: "Read current todo list for tracking task progress",
  params: TodoReadParams,
  execute: Effect.fn("TodoReadTool.execute")(function* () {
    const handler = yield* TodoHandler
    const todos = yield* handler.list()
    return {
      todos: todos.map((t) => ({
        id: t.id,
        content: t.content,
        status: t.status,
        priority: t.priority,
      })),
    }
  }),
})

// TodoWrite Params & Result

const TodoInputSchema = Schema.Struct({
  content: Schema.String.annotations({
    description: "Task description",
  }),
  status: TodoStatus.annotations({
    description: "Task status: pending, in_progress, or completed",
  }),
  priority: Schema.optional(
    TodoPriority.annotations({
      description: "Optional priority: high, medium, or low",
    }),
  ),
})

export const TodoWriteParams = Schema.Struct({
  todos: Schema.Array(TodoInputSchema).annotations({
    description: "Complete todo list (replaces existing)",
  }),
})

export const TodoWriteResult = Schema.Struct({
  count: Schema.Number,
})

// TodoWrite Tool

export const TodoWriteTool = defineTool({
  name: "todo_write",
  concurrency: "serial",
  description:
    "Update todo list with new tasks. Replaces entire list. Use for tracking multi-step work.",
  params: TodoWriteParams,
  execute: Effect.fn("TodoWriteTool.execute")(function* (params) {
    const handler = yield* TodoHandler
    const now = new Date()
    const todos = params.todos.map(
      (t, i) =>
        new TodoItem({
          id: `todo-${Date.now()}-${i}`,
          content: t.content,
          status: t.status,
          priority: t.priority,
          createdAt: now,
          updatedAt: now,
        }),
    )
    yield* handler.replace(todos)
    return { count: todos.length }
  }),
})
