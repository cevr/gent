import { Effect, Schema } from "effect"
import { tool, AgentName, SessionId, ToolNeeds } from "@gent/core/extensions/api"
import { TodoId, TodoStatus } from "./domain.js"
import { TodoStorageReadOnly } from "../todo-storage.js"

export const TodoListParams = Schema.Struct({
  status: Schema.optionalKey(
    TodoStatus.annotate({ description: "Optional status filter for listed todos" }),
  ),
})

export const TodoListResult = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      id: TodoId,
      parentId: Schema.optional(TodoId),
      subject: Schema.String,
      status: TodoStatus,
      owner: Schema.optional(SessionId),
      agent: Schema.optional(AgentName),
    }),
  ),
  summary: Schema.Union([
    Schema.String,
    Schema.Struct({
      total: Schema.Number,
      pending: Schema.Number,
      in_progress: Schema.Number,
      completed: Schema.Number,
      failed: Schema.Number,
    }),
  ]),
})

export const TodoListTool = tool({
  id: "todo_list",
  needs: [ToolNeeds.read("todo")],
  description: "List all todos for the current session and branch, sorted by creation time.",
  params: TodoListParams,
  output: TodoListResult,
  execute: Effect.fn("TodoListTool.execute")(function* (params, ctx) {
    const todoService = yield* TodoStorageReadOnly
    const allTodos = yield* todoService.listTodos(ctx.sessionId, ctx.branchId)
    const todos =
      params.status === undefined
        ? allTodos
        : allTodos.filter((todo) => todo.status === params.status)

    if (todos.length === 0) {
      return { todos: [], summary: "No todos" }
    }

    const summary = {
      total: todos.length,
      pending: todos.filter((t) => t.status === "pending").length,
      in_progress: todos.filter((t) => t.status === "in_progress").length,
      completed: todos.filter((t) => t.status === "completed").length,
      failed: todos.filter((t) => t.status === "failed").length,
    }

    return {
      todos: todos.map((t) => ({
        id: t.id,
        ...(t.parentId !== undefined ? { parentId: t.parentId } : {}),
        subject: t.subject,
        status: t.status,
        ...(t.owner !== undefined ? { owner: t.owner } : {}),
        ...(t.agentType !== undefined ? { agent: t.agentType } : {}),
      })),
      summary,
    }
  }),
})
