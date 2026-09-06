import { Effect, Option, Predicate, Schema } from "effect"
import { AgentName, ExtensionContext, SessionId, tool } from "@gent/core/extensions/api"
import { TodoId, TodoStatus, TodoTransitionError } from "./domain.js"
import { TodoStorageReadOnly } from "../todo-storage.js"
import { TodoService } from "../todo-service.js"

const JsonValueSchema = Schema.Unknown
type JsonValue = Schema.Schema.Type<typeof JsonValueSchema>

const storageFailure = (operation: string, error: JsonValue) => ({
  error: `${operation} failed: ${String(error)}`,
})

type TodoCreateResultValue = {
  todoId: TodoId
  parentId?: TodoId
  subject: string
  status: TodoStatus
  blockedBy?: ReadonlyArray<string>
}

type TodoListItemValue = {
  id: TodoId
  parentId?: TodoId
  subject: string
  status: TodoStatus
  owner?: SessionId
  agent?: AgentName
}

type TodoGetResultValue = {
  error?: string
  id?: TodoId
  parentId?: TodoId
  subject?: string
  status?: TodoStatus
  description?: string
  agent?: AgentName
  prompt?: string
  owner?: SessionId
  cwd?: string
  metadata?: JsonValue
  blockedBy?: ReadonlyArray<TodoId>
  createdAt?: number
}

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
    const createParams: Parameters<typeof todoService.create>[0] = {
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      subject: params.subject,
    }
    if (Predicate.isNotUndefined(params.parentId)) {
      createParams.parentId = TodoId.make(params.parentId)
    }
    if (Predicate.isNotUndefined(params.description)) createParams.description = params.description
    if (Predicate.isNotUndefined(params.agent)) createParams.agentType = params.agent
    if (Predicate.isNotUndefined(params.prompt)) createParams.prompt = params.prompt
    if (Predicate.isNotUndefined(params.cwd)) createParams.cwd = params.cwd
    const todo = yield* todoService.create(createParams)

    if (Predicate.isNotUndefined(params.blockedBy)) {
      for (const depId of params.blockedBy) {
        yield* todoService.addDep(todo.id, TodoId.make(depId))
      }
    }

    const result: TodoCreateResultValue = {
      todoId: todo.id,
      subject: todo.subject,
      status: todo.status,
    }
    if (Predicate.isNotUndefined(todo.parentId)) result.parentId = todo.parentId
    if (Predicate.isNotUndefined(params.blockedBy)) result.blockedBy = params.blockedBy
    return result
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
      total: Schema.Finite,
      pending: Schema.Finite,
      in_progress: Schema.Finite,
      completed: Schema.Finite,
      failed: Schema.Finite,
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
    let todos = allTodos
    if (Predicate.isNotUndefined(params.status)) {
      todos = allTodos.filter((todo) => todo.status === params.status)
    }

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
      todos: todos.map((t) => {
        const item: TodoListItemValue = {
          id: t.id,
          subject: t.subject,
          status: t.status,
        }
        if (Predicate.isNotUndefined(t.parentId)) item.parentId = t.parentId
        if (Predicate.isNotUndefined(t.owner)) item.owner = t.owner
        if (Predicate.isNotUndefined(t.agentType)) item.agent = t.agentType
        return item
      }),
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
  createdAt: Schema.optional(Schema.Finite),
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
    if ("error" in todo) return todo
    if (Option.isNone(todo)) {
      return { error: `Todo not found: ${params.todoId}` }
    }
    const todoValue = todo.value

    const deps = yield* todoService
      .getTodoDeps(todoId)
      .pipe(
        Effect.catchEager((error) =>
          Effect.succeed(storageFailure("Todo dependency lookup", error)),
        ),
      )
    if ("error" in deps) return deps

    const result: TodoGetResultValue = {
      id: todoValue.id,
      subject: todoValue.subject,
      status: todoValue.status,
      createdAt: todoValue.createdAt.getTime(),
    }
    if (Predicate.isNotUndefined(todoValue.parentId)) result.parentId = todoValue.parentId
    if (Predicate.isNotUndefined(todoValue.description)) result.description = todoValue.description
    if (Predicate.isNotUndefined(todoValue.agentType)) result.agent = todoValue.agentType
    if (Predicate.isNotUndefined(todoValue.prompt)) result.prompt = todoValue.prompt
    if (Predicate.isNotUndefined(todoValue.owner)) result.owner = todoValue.owner
    if (Predicate.isNotUndefined(todoValue.cwd)) result.cwd = todoValue.cwd
    if (Predicate.isNotUndefined(todoValue.metadata)) result.metadata = todoValue.metadata
    if (deps.length > 0) result.blockedBy = deps
    return result
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
    const fields: Parameters<typeof todoService.update>[1] = {}
    if (Predicate.isNotUndefined(params.status)) fields.status = params.status
    if (Predicate.isNotUndefined(params.description)) fields.description = params.description
    if (Predicate.isString(params.parentId)) fields.parentId = TodoId.make(params.parentId)
    if (Predicate.isNull(params.parentId)) fields.parentId = params.parentId
    const updated = yield* todoService
      .update(TodoId.make(params.todoId), fields)
      .pipe(
        Effect.catchIf(Schema.is(TodoTransitionError), (error) =>
          Effect.succeed({ error: error.message }),
        ),
      )

    if ("error" in updated) return updated
    if (Option.isNone(updated)) {
      return { error: `Todo not found: ${params.todoId}` }
    }

    return {
      id: updated.value.id,
      subject: updated.value.subject,
      status: updated.value.status,
      parentId: updated.value.parentId,
    }
  }),
})
