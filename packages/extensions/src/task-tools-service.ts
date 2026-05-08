import { Context, DateTime, Effect, Layer, Option, Random, Schema } from "effect"
import {
  ExtensionStatePublisher,
  type CapabilityError,
  type AgentName,
  type SessionId,
  type BranchId,
  requireCapabilityWrite,
} from "@gent/core/extensions/api"
import {
  Task,
  TaskId,
  TaskTransitionError,
  isValidTaskTransition,
  type TaskStatus,
} from "./task-tools/domain.js"
import { TaskStorage, type TaskStorageError } from "./task-tools-storage.js"
import { TASK_TOOLS_EXTENSION_ID } from "./task-tools/identity.js"

// Extension-owned task service. Present only when @gent/task-tools is loaded.
// Pure state management — no execution, no fibers, no agent spawning.

const requireTaskWrite = (operation: string) =>
  requireCapabilityWrite({
    tag: "task",
    extensionId: TASK_TOOLS_EXTENSION_ID,
    capabilityId: operation,
    operation,
  })

export class TaskServiceUnavailableError extends Schema.TaggedErrorClass<TaskServiceUnavailableError>()(
  "TaskServiceUnavailableError",
  {
    message: Schema.String,
  },
) {}

type TaskServiceFallbackApi = {
  readonly create: (params: {
    sessionId: SessionId
    branchId: BranchId
    subject: string
    description?: string
    agentType?: AgentName
    prompt?: string
    cwd?: string
    metadata?: unknown
  }) => Effect.Effect<Task, TaskServiceUnavailableError>
  readonly get: (id: TaskId) => Effect.Effect<Task | undefined>
  readonly list: (sessionId: SessionId, branchId?: BranchId) => Effect.Effect<ReadonlyArray<Task>>
  readonly update: (
    id: TaskId,
    fields: Partial<{
      status: TaskStatus
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<Task | undefined>
  readonly remove: (id: TaskId) => Effect.Effect<void>
  readonly addDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly removeDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly getDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>>
}

export interface TaskServiceApi {
  readonly create: (params: {
    sessionId: SessionId
    branchId: BranchId
    subject: string
    description?: string
    agentType?: AgentName
    prompt?: string
    cwd?: string
    metadata?: unknown
  }) => Effect.Effect<
    Task,
    CapabilityError | TaskStorageError | TaskServiceUnavailableError,
    ExtensionStatePublisher
  >

  readonly get: (id: TaskId) => Effect.Effect<Task | undefined, TaskStorageError>

  readonly list: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, TaskStorageError>

  readonly update: (
    id: TaskId,
    fields: Partial<{
      status: TaskStatus
      description: string | null
      owner: string | null
      metadata: unknown | null
    }>,
  ) => Effect.Effect<
    Task | undefined,
    CapabilityError | TaskStorageError | TaskTransitionError,
    ExtensionStatePublisher
  >

  readonly remove: (
    id: TaskId,
  ) => Effect.Effect<void, CapabilityError | TaskStorageError, ExtensionStatePublisher>

  readonly addDep: (
    taskId: TaskId,
    blockedById: TaskId,
  ) => Effect.Effect<void, CapabilityError | TaskStorageError>
  readonly removeDep: (
    taskId: TaskId,
    blockedById: TaskId,
  ) => Effect.Effect<void, CapabilityError | TaskStorageError>
  readonly getDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>, TaskStorageError>
}

export class TaskService extends Context.Service<TaskService, TaskServiceApi>()(
  "@gent/extensions/src/task-tools-service/TaskService",
) {
  /** No-op TaskService returned when @gent/task-tools is disabled (TaskStorage absent) */
  private static readonly Noop: TaskServiceFallbackApi = {
    create: () =>
      Effect.fail(
        new TaskServiceUnavailableError({
          message: "TaskStorage not available — @gent/task-tools is disabled",
        }),
      ),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    get: () => Effect.succeed<Task | undefined>(undefined),
    list: () => Effect.succeed<ReadonlyArray<Task>>([]),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off
    update: () => Effect.succeed<Task | undefined>(undefined),
    remove: () => Effect.void,
    addDep: () => Effect.void,
    removeDep: () => Effect.void,
    getDeps: () => Effect.succeed([]),
  }

  static Live: Layer.Layer<TaskService> = Layer.succeed(TaskService, {
    create: (params) =>
      Effect.gen(function* () {
        yield* requireTaskWrite("TaskService.create")
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) return yield* TaskService.Noop.create(params)
        const storage = storageOption.value
        const extensionState = yield* ExtensionStatePublisher
        const id = TaskId.make(yield* Random.nextUUIDv4)
        const now = yield* DateTime.nowAsDate
        const task = Task.make({
          id,
          sessionId: params.sessionId,
          branchId: params.branchId,
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
        yield* storage.createTask(task)
        yield* extensionState
          .changed({
            sessionId: params.sessionId,
            branchId: params.branchId,
            extensionId: TASK_TOOLS_EXTENSION_ID,
          })
          .pipe(Effect.catchEager(() => Effect.void))
        return task
      }),

    get: (id) =>
      Effect.gen(function* () {
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) return yield* TaskService.Noop.get(id)
        return yield* storageOption.value.getTask(id)
      }),

    list: (sessionId, branchId) =>
      Effect.gen(function* () {
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) return yield* TaskService.Noop.list(sessionId, branchId)
        return yield* storageOption.value.listTasks(sessionId, branchId)
      }),

    update: (id, fields) =>
      Effect.gen(function* () {
        yield* requireTaskWrite("TaskService.update")
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) return yield* TaskService.Noop.update(id, fields)
        const storage = storageOption.value
        const extensionState = yield* ExtensionStatePublisher
        if (fields.status !== undefined) {
          const existing = yield* storage.getTask(id)
          if (existing !== undefined && !isValidTaskTransition(existing.status, fields.status)) {
            return yield* new TaskTransitionError({
              message: `Invalid task transition: ${existing.status} → ${fields.status}`,
              from: existing.status,
              to: fields.status,
            })
          }
        }
        const updated = yield* storage.updateTask(id, fields)
        if (updated !== undefined && fields.status !== undefined) {
          yield* extensionState
            .changed({
              sessionId: updated.sessionId,
              branchId: updated.branchId,
              extensionId: TASK_TOOLS_EXTENSION_ID,
            })
            .pipe(Effect.catchEager(() => Effect.void))
        }
        return updated
      }),

    remove: (id) =>
      Effect.gen(function* () {
        yield* requireTaskWrite("TaskService.remove")
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) return yield* TaskService.Noop.remove(id)
        const storage = storageOption.value
        const extensionState = yield* ExtensionStatePublisher
        const existing = yield* storage.getTask(id)
        if (existing === undefined) {
          yield* storage.deleteTask(id)
          return
        }
        yield* storage.deleteTask(id)
        yield* extensionState
          .changed({
            sessionId: existing.sessionId,
            branchId: existing.branchId,
            extensionId: TASK_TOOLS_EXTENSION_ID,
          })
          .pipe(Effect.catchEager(() => Effect.void))
      }),

    addDep: (taskId, blockedById) =>
      Effect.gen(function* () {
        yield* requireTaskWrite("TaskService.addDep")
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) return yield* TaskService.Noop.addDep(taskId, blockedById)
        yield* storageOption.value.addTaskDep(taskId, blockedById)
      }),
    removeDep: (taskId, blockedById) =>
      Effect.gen(function* () {
        yield* requireTaskWrite("TaskService.removeDep")
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) {
          return yield* TaskService.Noop.removeDep(taskId, blockedById)
        }
        yield* storageOption.value.removeTaskDep(taskId, blockedById)
      }),
    getDeps: (taskId) =>
      Effect.gen(function* () {
        const storageOption = yield* Effect.serviceOption(TaskStorage)
        if (Option.isNone(storageOption)) return yield* TaskService.Noop.getDeps(taskId)
        return yield* storageOption.value.getTaskDeps(taskId)
      }),
  })

  static Test = (): Layer.Layer<TaskService> => Layer.succeed(TaskService, TaskService.Noop)
}
