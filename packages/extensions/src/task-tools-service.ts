import { Context, DateTime, Effect, Layer, Option, Random, Schema } from "effect"
import {
  Task,
  TaskTransitionError,
  isValidTaskTransition,
  TaskId,
  ExtensionStatePublisher,
  type TaskStatus,
  type AgentName,
  type SessionId,
  type BranchId,
} from "@gent/core/extensions/api"
import { TaskStorage, type TaskStorageService } from "./task-tools-storage.js"
import { TASK_TOOLS_EXTENSION_ID } from "./task-tools/identity.js"

// Extension-owned task service. Present only when @gent/task-tools is loaded.
// Pure state management — no execution, no fibers, no agent spawning.

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
  }) => Effect.Effect<Task, TaskServiceUnavailableError, ExtensionStatePublisher>

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
  ) => Effect.Effect<Task | undefined, TaskTransitionError, ExtensionStatePublisher>

  readonly remove: (id: TaskId) => Effect.Effect<void, never, ExtensionStatePublisher>

  readonly addDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly removeDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly getDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>>
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
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.create(params),
            onSome: (storage: TaskStorageService) =>
              Effect.gen(function* () {
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
                yield* extensionState.changed({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  extensionId: TASK_TOOLS_EXTENSION_ID,
                })
                return task
              }).pipe(Effect.orDie),
          }),
        ),
      ),

    get: (id) =>
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.get(id),
            onSome: (storage: TaskStorageService) => storage.getTask(id).pipe(Effect.orDie),
          }),
        ),
      ),

    list: (sessionId, branchId) =>
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.list(sessionId, branchId),
            onSome: (storage: TaskStorageService) =>
              storage.listTasks(sessionId, branchId).pipe(Effect.orDie),
          }),
        ),
      ),

    update: (id, fields) =>
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.update(id, fields),
            onSome: (storage: TaskStorageService) =>
              Effect.gen(function* () {
                const extensionState = yield* ExtensionStatePublisher
                // Validate status transition if status is being changed
                if (fields.status !== undefined) {
                  const existing = yield* storage.getTask(id)
                  if (
                    existing !== undefined &&
                    !isValidTaskTransition(existing.status, fields.status)
                  ) {
                    return yield* new TaskTransitionError({
                      message: `Invalid task transition: ${existing.status} → ${fields.status}`,
                      from: existing.status,
                      to: fields.status,
                    })
                  }
                }
                const updated = yield* storage.updateTask(id, fields)
                if (updated !== undefined && fields.status !== undefined) {
                  yield* extensionState.changed({
                    sessionId: updated.sessionId,
                    branchId: updated.branchId,
                    extensionId: TASK_TOOLS_EXTENSION_ID,
                  })
                }
                return updated
              }).pipe(Effect.orDie),
          }),
        ),
      ),

    remove: (id) =>
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.remove(id),
            onSome: (storage: TaskStorageService) =>
              Effect.gen(function* () {
                const extensionState = yield* ExtensionStatePublisher
                const existing = yield* storage.getTask(id).pipe(Effect.orDie)
                if (existing === undefined) {
                  yield* storage.deleteTask(id).pipe(Effect.orDie)
                  return
                }
                yield* storage.deleteTask(id).pipe(Effect.orDie)
                yield* extensionState
                  .changed({
                    sessionId: existing.sessionId,
                    branchId: existing.branchId,
                    extensionId: TASK_TOOLS_EXTENSION_ID,
                  })
                  .pipe(Effect.catchEager(() => Effect.void))
              }),
          }),
        ),
      ),

    addDep: (taskId, blockedById) =>
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.addDep(taskId, blockedById),
            onSome: (storage: TaskStorageService) =>
              storage.addTaskDep(taskId, blockedById).pipe(Effect.orDie),
          }),
        ),
      ),
    removeDep: (taskId, blockedById) =>
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.removeDep(taskId, blockedById),
            onSome: (storage: TaskStorageService) =>
              storage.removeTaskDep(taskId, blockedById).pipe(Effect.orDie),
          }),
        ),
      ),
    getDeps: (taskId) =>
      Effect.serviceOption(TaskStorage).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => TaskService.Noop.getDeps(taskId),
            onSome: (storage: TaskStorageService) => storage.getTaskDeps(taskId).pipe(Effect.orDie),
          }),
        ),
      ),
  })

  static Test = (): Layer.Layer<TaskService> => Layer.succeed(TaskService, TaskService.Noop)
}
