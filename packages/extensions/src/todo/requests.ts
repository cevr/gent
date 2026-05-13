/**
 * Todo requests — typed request Capabilities authored through the
 * unified `request({...})` factory.
 *
 * Requests yield the smallest extension-owned service they need. Host
 * authority comes from `ExtensionContext`.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import {
  AgentName,
  CapabilityError,
  defineRequests,
  ExtensionContext,
  request,
} from "@gent/core/extensions/api"
import { Todo, TodoId, TODO_EXTENSION_ID } from "./domain.js"
import { TodoService } from "../todo-service.js"
import { TodoStorageReadOnly } from "../todo-storage.js"

// ── Read Requests ──

const todoCapabilityError = (capabilityId: string, operation: string, error: unknown) =>
  new CapabilityError({
    extensionId: TODO_EXTENSION_ID,
    capabilityId,
    reason: `${operation} failed: ${String(error)}`,
  })

export const TodoGetInput = Schema.Struct({ todoId: TodoId })
export const TodoGetOutput = Schema.NullOr(Todo)

export const TodoGetRequest = request({
  id: "todo.get",
  input: TodoGetInput,
  output: TodoGetOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const storage = yield* TodoStorageReadOnly
      const todo = yield* storage
        .getTodo(input.todoId)
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.get", "TodoStorage.getTodo", e)),
          ),
        )
      return todo ?? null
    }),
})

export const TodoListInput = Schema.Struct({})
export const TodoListOutput = Schema.Array(Todo)

export const TodoListRequest = request({
  id: "todo.list",
  input: TodoListInput,
  output: TodoListOutput,
  execute: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const storage = yield* TodoStorageReadOnly
      return yield* storage
        .listTodos(ctx.sessionId, ctx.branchId)
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.list", "TodoStorage.listTodos", e)),
          ),
        )
    }),
})

export const TodoGetDepsInput = Schema.Struct({ todoId: TodoId })
export const TodoGetDepsOutput = Schema.Array(TodoId)

export const TodoGetDepsRequest = request({
  id: "todo.getDeps",
  input: TodoGetDepsInput,
  output: TodoGetDepsOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const storage = yield* TodoStorageReadOnly
      return yield* storage
        .getTodoDeps(input.todoId)
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.getDeps", "TodoStorage.getTodoDeps", e)),
          ),
        )
    }),
})

// ── Write Requests ──

export const TodoCreateInput = Schema.Struct({
  parentId: Schema.optional(TodoId),
  subject: Schema.String,
  description: Schema.optional(Schema.String),
  agentType: Schema.optional(AgentName),
  prompt: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
})
export const TodoCreateOutput = Todo

export const TodoCreateRequest = request({
  id: "todo.create",
  input: TodoCreateInput,
  output: TodoCreateOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const todoService = yield* TodoService
      return yield* todoService
        .create({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          parentId: input.parentId,
          subject: input.subject,
          description: input.description,
          agentType: input.agentType,
          prompt: input.prompt,
          cwd: input.cwd,
          metadata: input.metadata,
        })
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.create", "TodoService.create", e)),
          ),
        )
    }),
})

export const TodoUpdateInput = Schema.Struct({
  todoId: TodoId,
  status: Schema.optional(
    Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]),
  ),
  parentId: Schema.optional(Schema.NullOr(TodoId)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.Unknown)),
})
export const TodoUpdateOutput = Schema.NullOr(Todo)

export const TodoUpdateRequest = request({
  id: "todo.update",
  input: TodoUpdateInput,
  output: TodoUpdateOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const todoService = yield* TodoService
      const { todoId, ...fields } = input
      const result = yield* todoService
        .update(todoId, fields)
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.update", "TodoService.update", e)),
          ),
        )
      return result ?? null
    }),
})

export const TodoDeleteInput = Schema.Struct({ todoId: TodoId })
export const TodoDeleteOutput = Schema.Null

export const TodoDeleteRequest = request({
  id: "todo.delete",
  input: TodoDeleteInput,
  output: TodoDeleteOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const todoService = yield* TodoService
      yield* todoService
        .remove(input.todoId)
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.delete", "TodoService.remove", e)),
          ),
        )
      return null
    }),
})

export const TodoAddDepInput = Schema.Struct({ todoId: TodoId, blockedById: TodoId })
export const TodoAddDepOutput = Schema.Null

export const TodoAddDepRequest = request({
  id: "todo.addDep",
  input: TodoAddDepInput,
  output: TodoAddDepOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const todoService = yield* TodoService
      yield* todoService
        .addDep(input.todoId, input.blockedById)
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.addDep", "TodoService.addDep", e)),
          ),
        )
      return null
    }),
})

export const TodoRemoveDepInput = Schema.Struct({ todoId: TodoId, blockedById: TodoId })
export const TodoRemoveDepOutput = Schema.Null

export const TodoRemoveDepRequest = request({
  id: "todo.removeDep",
  input: TodoRemoveDepInput,
  output: TodoRemoveDepOutput,
  execute: (input) =>
    Effect.gen(function* () {
      const todoService = yield* TodoService
      yield* todoService
        .removeDep(input.todoId, input.blockedById)
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(todoCapabilityError("todo.removeDep", "TodoService.removeDep", e)),
          ),
        )
      return null
    }),
})

defineRequests(TODO_EXTENSION_ID, {
  TodoAddDepRequest,
  TodoCreateRequest,
  TodoDeleteRequest,
  TodoGetDepsRequest,
  TodoGetRequest,
  TodoListRequest,
  TodoRemoveDepRequest,
  TodoUpdateRequest,
})
