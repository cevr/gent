import { Effect, Schema } from "effect"
import { AgentName, ExtensionContext, SessionId, tool } from "@gent/core/extensions/api"
import { TodoId, TodoStatus, TodoTransitionError } from "./domain.js"
import { TodoStorageReadOnly } from "../todo-storage.js"
import { TodoService } from "../todo-service.js"

const storageFailure = (operation: string, error: unknown) => ({
  error: `${operation} failed: ${String(error)}`,
})

export const TodoCreateParams = Schema.Struct({
  parentId: Schema.optionalKey(
    Schema.String.annotate({ description: "Optional parent todo ID for nested todo tracking" }),
  ),
  subject: Schema.String.annotate({ description: "Brief todo title in imperative form" }),
  description: Schema.optionalKey(
    Schema.String.annotate({ description: "Detailed description of what needs to be done" }),
  ),
  agent: Schema.optionalKey(AgentName.annotate({ description: "Agent type to execute this todo" })),
  prompt: Schema.optionalKey(
    Schema.String.annotate({ description: "Execution prompt for the agent" }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({ description: "Working directory for execution" }),
  ),
  blockedBy: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Todo IDs that must complete before this one can start",
    }),
  ),
})

export const TodoCreateResult = Schema.Struct({
  todoId: TodoId,
  parentId: Schema.optional(TodoId),
  subject: Schema.String,
  status: TodoStatus,
  blockedBy: Schema.optional(Schema.Array(Schema.String)),
})

export const TodoCreateTool = tool({
  id: "todo_create",
  description:
    "Create a durable todo with optional dependencies. Todos persist across turns and can be run in the background. Set agent + prompt for executable todos.",
  params: TodoCreateParams,
  output: TodoCreateResult,
  execute: Effect.fn("TodoCreateTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const todoService = yield* TodoService
    const todo = yield* todoService.create({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      parentId: params.parentId !== undefined ? TodoId.make(params.parentId) : undefined,
      subject: params.subject,
      description: params.description,
      agentType: params.agent,
      prompt: params.prompt,
      cwd: params.cwd,
    })

    if (params.blockedBy !== undefined) {
      for (const depId of params.blockedBy) {
        yield* todoService.addDep(todo.id, TodoId.make(depId))
      }
    }

    return {
      todoId: todo.id,
      ...(todo.parentId !== undefined ? { parentId: todo.parentId } : {}),
      subject: todo.subject,
      status: todo.status,
      ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
    }
  }),
})

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
  description: "List all todos for the current session and branch, sorted by creation time.",
  params: TodoListParams,
  output: TodoListResult,
  execute: Effect.fn("TodoListTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
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

export const TodoUpdateParams = Schema.Struct({
  todoId: Schema.String.annotate({ description: "Todo ID to update" }),
  status: Schema.optionalKey(
    Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]).annotate({
      description: "New status",
    }),
  ),
  parentId: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({
        description: "Parent todo ID for nesting, or null to move to the root",
      }),
    ),
  ),
  description: Schema.optionalKey(Schema.String.annotate({ description: "Updated description" })),
})

export const TodoUpdateResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  id: Schema.optional(TodoId),
  subject: Schema.optional(Schema.String),
  status: Schema.optional(TodoStatus),
  parentId: Schema.optional(TodoId),
})

export const TodoUpdateTool = tool({
  id: "todo_update",
  description:
    "Update a todo's status or description. Use status 'completed' to mark done, 'failed' for errors.",
  params: TodoUpdateParams,
  output: TodoUpdateResult,
  execute: Effect.fn("TodoUpdateTool.execute")(function* (params: typeof TodoUpdateParams.Type) {
    const todoService = yield* TodoService
    const updated = yield* todoService
      .update(TodoId.make(params.todoId), {
        status: params.status,
        parentId:
          params.parentId !== undefined && params.parentId !== null
            ? TodoId.make(params.parentId)
            : params.parentId,
        description: params.description,
      })
      .pipe(
        Effect.catchIf(Schema.is(TodoTransitionError), (error) =>
          Effect.succeed({ error: error.message }),
        ),
      )

    if (updated == null) {
      return { error: `Todo not found: ${params.todoId}` }
    }
    if ("error" in updated) return updated

    return {
      id: updated.id,
      subject: updated.subject,
      status: updated.status,
      parentId: updated.parentId,
    }
  }),
})
