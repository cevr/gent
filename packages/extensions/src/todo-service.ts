import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import {
  ExtensionContext,
  type AgentName,
  type BranchId,
  type SessionId,
} from "@gent/core/extensions/api"
import { Todo, TodoId, type TodoStatus, type TodoTransitionError } from "./todo/domain.js"
import { TodoStorage, type TodoStorageError } from "./todo-storage.js"

const NullableTodoId = Schema.NullOr(TodoId)
type NullableTodoId = typeof NullableTodoId.Type
const NullableString = Schema.NullOr(Schema.String)
type NullableString = typeof NullableString.Type
const NullableJsonValue = Schema.NullOr(Schema.Unknown)
type NullableJsonValue = typeof NullableJsonValue.Type

// Extension-owned todo service. Present only when @gent/todo is loaded.
// Pure state management — no execution, no fibers, no agent spawning.

export class TodoServiceUnavailableError extends Schema.TaggedError<TodoServiceUnavailableError>()(
  "TodoServiceUnavailableError",
  {
    message: Schema.String,
  },
) {}

type TodoServiceFallbackApi = {
  readonly create: (params: {
    sessionId: SessionId
    branchId: BranchId
    parentId?: TodoId
    subject: string
    description?: string
    agentType?: AgentName
    prompt?: string
    cwd?: string
    metadata?: unknown
  }) => Effect.Effect<Todo, TodoServiceUnavailableError>
  readonly get: (id: TodoId) => Effect.Effect<Option.Option<Todo>>
  readonly list: (sessionId: SessionId, branchId?: BranchId) => Effect.Effect<ReadonlyArray<Todo>>
  readonly update: (
    id: TodoId,
    fields: Partial<{
      status: TodoStatus
      parentId: NullableTodoId
      description: NullableString
      owner: NullableString
      metadata: NullableJsonValue
    }>,
  ) => Effect.Effect<Option.Option<Todo>>
  readonly remove: (id: TodoId) => Effect.Effect<void>
  readonly addDep: (todoId: TodoId, blockedById: TodoId) => Effect.Effect<void>
  readonly removeDep: (todoId: TodoId, blockedById: TodoId) => Effect.Effect<void>
  readonly getDeps: (todoId: TodoId) => Effect.Effect<ReadonlyArray<TodoId>>
}

export interface TodoServiceApi {
  readonly create: (params: {
    sessionId: SessionId
    branchId: BranchId
    parentId?: TodoId
    subject: string
    description?: string
    agentType?: AgentName
    prompt?: string
    cwd?: string
    metadata?: unknown
  }) => Effect.Effect<Todo, TodoStorageError | TodoServiceUnavailableError, ExtensionContext>

  readonly get: (id: TodoId) => Effect.Effect<Option.Option<Todo>, TodoStorageError>

  readonly list: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Todo>, TodoStorageError>

  readonly update: (
    id: TodoId,
    fields: Partial<{
      status: TodoStatus
      parentId: NullableTodoId
      description: NullableString
      owner: NullableString
      metadata: NullableJsonValue
    }>,
  ) => Effect.Effect<Option.Option<Todo>, TodoStorageError | TodoTransitionError, ExtensionContext>

  readonly remove: (id: TodoId) => Effect.Effect<void, TodoStorageError, ExtensionContext>

  readonly addDep: (todoId: TodoId, blockedById: TodoId) => Effect.Effect<void, TodoStorageError>
  readonly removeDep: (todoId: TodoId, blockedById: TodoId) => Effect.Effect<void, TodoStorageError>
  readonly getDeps: (todoId: TodoId) => Effect.Effect<ReadonlyArray<TodoId>, TodoStorageError>
}

export class TodoService extends Context.Service<TodoService, TodoServiceApi>()(
  "@gent/extensions/src/todo-service/TodoService",
) {
  /** No-op TodoService returned when @gent/todo is disabled (TodoStorage absent) */
  private static readonly Noop: TodoServiceFallbackApi = {
    create: () =>
      Effect.fail(
        new TodoServiceUnavailableError({
          message: "TodoStorage not available — @gent/todo is disabled",
        }),
      ),
    get: () => Effect.succeed(Option.none<Todo>()),
    list: () => Effect.succeed<ReadonlyArray<Todo>>([]),
    update: () => Effect.succeed(Option.none<Todo>()),
    remove: () => Effect.void,
    addDep: () => Effect.void,
    removeDep: () => Effect.void,
    getDeps: () => Effect.succeed([]),
  }

  static Live: Layer.Layer<TodoService> = Layer.succeed(
    TodoService,
    TodoService.of({
      create: (params) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption)) return yield* TodoService.Noop.create(params)
          const storage = storageOption.value
          const ctx = yield* ExtensionContext
          const id = TodoId.make(yield* ctx.Process.randomId)
          const now = yield* DateTime.nowAsDate
          const todo = Todo.make({
            id,
            sessionId: params.sessionId,
            branchId: params.branchId,
            parentId: params.parentId,
            subject: params.subject,
            description: params.description,
            status: "pending",
            agentType: params.agentType,
            prompt: params.prompt,
            cwd: params.cwd,
            metadata: params.metadata,
            createdAt: now,
            updatedAt: now,
          })
          yield* storage.createTodo(todo)
          yield* ctx.State.changed({
            sessionId: params.sessionId,
            branchId: params.branchId,
          }).pipe(Effect.catchEager(() => Effect.void))
          return todo
        }),

      get: (id) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption)) return yield* TodoService.Noop.get(id)
          return yield* storageOption.value.getTodo(id)
        }),

      list: (sessionId, branchId) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption)) return yield* TodoService.Noop.list(sessionId, branchId)
          return yield* storageOption.value.listTodos(sessionId, branchId)
        }),

      update: (id, fields) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption)) return yield* TodoService.Noop.update(id, fields)
          const storage = storageOption.value
          const ctx = yield* ExtensionContext
          const updated = yield* storage.updateTodo(id, fields)
          if (Option.isSome(updated)) {
            yield* ctx.State.changed({
              sessionId: updated.value.sessionId,
              branchId: updated.value.branchId,
            }).pipe(Effect.catchEager(() => Effect.void))
          }
          return updated
        }),

      remove: (id) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption)) return yield* TodoService.Noop.remove(id)
          const storage = storageOption.value
          const ctx = yield* ExtensionContext
          const existing = yield* storage.getTodo(id)
          if (Option.isNone(existing)) {
            yield* storage.deleteTodo(id)
            return
          }
          yield* storage.deleteTodo(id)
          yield* ctx.State.changed({
            sessionId: existing.value.sessionId,
            branchId: existing.value.branchId,
          }).pipe(Effect.catchEager(() => Effect.void))
        }),

      addDep: (todoId, blockedById) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption))
            return yield* TodoService.Noop.addDep(todoId, blockedById)
          yield* storageOption.value.addTodoDep(todoId, blockedById)
        }),
      removeDep: (todoId, blockedById) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption)) {
            return yield* TodoService.Noop.removeDep(todoId, blockedById)
          }
          yield* storageOption.value.removeTodoDep(todoId, blockedById)
        }),
      getDeps: (todoId) =>
        Effect.gen(function* () {
          const storageOption = yield* Effect.serviceOption(TodoStorage)
          if (Option.isNone(storageOption)) return yield* TodoService.Noop.getDeps(todoId)
          return yield* storageOption.value.getTodoDeps(todoId)
        }),
    }),
  )

  static Test = (): Layer.Layer<TodoService> => Layer.succeed(TodoService, TodoService.Noop)
}
