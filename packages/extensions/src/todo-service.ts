import { Context, DateTime, Effect, Layer, Option, Random, Schema } from "effect"
import {
  type CapabilityError,
  type AgentName,
  type SessionId,
  type BranchId,
} from "@gent/core/extensions/api"
import { requireCapabilityWrite } from "@gent/core-internal/domain/capability-access"
import { ExtensionStatePublisher } from "@gent/core-internal/domain/event-publisher"
import { Todo, TodoId, type TodoStatus, type TodoTransitionError } from "./todo/domain.js"
import { TodoStorage, type TodoStorageError } from "./todo-storage.js"
import { TODO_EXTENSION_ID } from "./todo/identity.js"

// Extension-owned todo service. Present only when @gent/todo is loaded.
// Pure state management — no execution, no fibers, no agent spawning.

const requireTodoWrite = (operation: string) =>
  requireCapabilityWrite({
    tag: "todo",
    extensionId: TODO_EXTENSION_ID,
    capabilityId: operation,
    operation,
  })

export class TodoServiceUnavailableError extends Schema.TaggedErrorClass<TodoServiceUnavailableError>()(
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
  readonly get: (id: TodoId) => Effect.Effect<Todo | undefined>
  readonly list: (sessionId: SessionId, branchId?: BranchId) => Effect.Effect<ReadonlyArray<Todo>>
  readonly update: (
    id: TodoId,
    fields: Partial<{
      status: TodoStatus
      parentId: TodoId | null
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<Todo | undefined>
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
  }) => Effect.Effect<
    Todo,
    CapabilityError | TodoStorageError | TodoServiceUnavailableError,
    ExtensionStatePublisher
  >

  readonly get: (id: TodoId) => Effect.Effect<Todo | undefined, TodoStorageError>

  readonly list: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Todo>, TodoStorageError>

  readonly update: (
    id: TodoId,
    fields: Partial<{
      status: TodoStatus
      parentId: TodoId | null
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<
    Todo | undefined,
    CapabilityError | TodoStorageError | TodoTransitionError,
    ExtensionStatePublisher
  >

  readonly remove: (
    id: TodoId,
  ) => Effect.Effect<void, CapabilityError | TodoStorageError, ExtensionStatePublisher>

  readonly addDep: (
    todoId: TodoId,
    blockedById: TodoId,
  ) => Effect.Effect<void, CapabilityError | TodoStorageError>
  readonly removeDep: (
    todoId: TodoId,
    blockedById: TodoId,
  ) => Effect.Effect<void, CapabilityError | TodoStorageError>
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
    get: () => Effect.sync((): Todo | undefined => undefined),
    list: () => Effect.succeed<ReadonlyArray<Todo>>([]),
    update: () => Effect.sync((): Todo | undefined => undefined),
    remove: () => Effect.void,
    addDep: () => Effect.void,
    removeDep: () => Effect.void,
    getDeps: () => Effect.succeed([]),
  }

  static Live: Layer.Layer<TodoService> = Layer.succeed(TodoService, {
    create: (params) =>
      Effect.gen(function* () {
        yield* requireTodoWrite("TodoService.create")
        const storageOption = yield* Effect.serviceOption(TodoStorage)
        if (Option.isNone(storageOption)) return yield* TodoService.Noop.create(params)
        const storage = storageOption.value
        const extensionState = yield* ExtensionStatePublisher
        const id = TodoId.make(yield* Random.nextUUIDv4)
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
        yield* extensionState
          .changed({
            sessionId: params.sessionId,
            branchId: params.branchId,
            extensionId: TODO_EXTENSION_ID,
          })
          .pipe(Effect.catchEager(() => Effect.void))
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
        yield* requireTodoWrite("TodoService.update")
        const storageOption = yield* Effect.serviceOption(TodoStorage)
        if (Option.isNone(storageOption)) return yield* TodoService.Noop.update(id, fields)
        const storage = storageOption.value
        const extensionState = yield* ExtensionStatePublisher
        const updated = yield* storage.updateTodo(id, fields)
        if (updated !== undefined) {
          yield* extensionState
            .changed({
              sessionId: updated.sessionId,
              branchId: updated.branchId,
              extensionId: TODO_EXTENSION_ID,
            })
            .pipe(Effect.catchEager(() => Effect.void))
        }
        return updated
      }),

    remove: (id) =>
      Effect.gen(function* () {
        yield* requireTodoWrite("TodoService.remove")
        const storageOption = yield* Effect.serviceOption(TodoStorage)
        if (Option.isNone(storageOption)) return yield* TodoService.Noop.remove(id)
        const storage = storageOption.value
        const extensionState = yield* ExtensionStatePublisher
        const existing = yield* storage.getTodo(id)
        if (existing === undefined) {
          yield* storage.deleteTodo(id)
          return
        }
        yield* storage.deleteTodo(id)
        yield* extensionState
          .changed({
            sessionId: existing.sessionId,
            branchId: existing.branchId,
            extensionId: TODO_EXTENSION_ID,
          })
          .pipe(Effect.catchEager(() => Effect.void))
      }),

    addDep: (todoId, blockedById) =>
      Effect.gen(function* () {
        yield* requireTodoWrite("TodoService.addDep")
        const storageOption = yield* Effect.serviceOption(TodoStorage)
        if (Option.isNone(storageOption)) return yield* TodoService.Noop.addDep(todoId, blockedById)
        yield* storageOption.value.addTodoDep(todoId, blockedById)
      }),
    removeDep: (todoId, blockedById) =>
      Effect.gen(function* () {
        yield* requireTodoWrite("TodoService.removeDep")
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
  })

  static Test = (): Layer.Layer<TodoService> => Layer.succeed(TodoService, TodoService.Noop)
}
