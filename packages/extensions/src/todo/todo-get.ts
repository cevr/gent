import { Effect, Schema } from "effect"
import { tool, AgentName, SessionId, ToolNeeds } from "@gent/core/extensions/api"
import { TodoId, TodoStatus } from "./domain.js"
import { TodoStorageReadOnly } from "../todo-storage.js"

const storageFailure = (operation: string, error: unknown) => ({
  error: `${operation} failed: ${String(error)}`,
})

export const TodoGetParams = Schema.Struct({
  todoId: Schema.String.annotate({ description: "Todo ID to get details for" }),
})

export const TodoGetResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  id: Schema.optional(TodoId),
  parentId: Schema.optional(TodoId),
  subject: Schema.optional(Schema.String),
  status: Schema.optional(TodoStatus),
  description: Schema.optional(Schema.String),
  agent: Schema.optional(AgentName),
  prompt: Schema.optional(Schema.String),
  owner: Schema.optional(SessionId),
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  blockedBy: Schema.optional(Schema.Array(TodoId)),
  createdAt: Schema.optional(Schema.Number),
})

export const TodoGetTool = tool({
  id: "todo_get",
  needs: [ToolNeeds.read("todo")],
  description: "Get full details of a todo including description, dependencies, and owner session.",
  params: TodoGetParams,
  output: TodoGetResult,
  execute: Effect.fn("TodoGetTool.execute")(function* (params) {
    const todoId = TodoId.make(params.todoId)
    const todoService = yield* TodoStorageReadOnly
    const todo = yield* todoService
      .getTodo(todoId)
      .pipe(Effect.catchEager((error) => Effect.succeed(storageFailure("Todo lookup", error))))
    if (todo !== undefined && "error" in todo) return todo
    if (todo == null) {
      return { error: `Todo not found: ${params.todoId}` }
    }

    const deps = yield* todoService
      .getTodoDeps(todoId)
      .pipe(
        Effect.catchEager((error) =>
          Effect.succeed(storageFailure("Todo dependency lookup", error)),
        ),
      )
    if ("error" in deps) return deps

    return {
      id: todo.id,
      ...(todo.parentId !== undefined ? { parentId: todo.parentId } : {}),
      subject: todo.subject,
      status: todo.status,
      ...(todo.description !== undefined ? { description: todo.description } : {}),
      ...(todo.agentType !== undefined ? { agent: todo.agentType } : {}),
      ...(todo.prompt !== undefined ? { prompt: todo.prompt } : {}),
      ...(todo.owner !== undefined ? { owner: todo.owner } : {}),
      ...(todo.cwd !== undefined ? { cwd: todo.cwd } : {}),
      ...(todo.metadata !== undefined ? { metadata: todo.metadata } : {}),
      ...(deps.length > 0 ? { blockedBy: deps } : {}),
      createdAt: todo.createdAt.getTime(),
    }
  }),
})
