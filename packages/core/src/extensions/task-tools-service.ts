import { Context, DateTime, Effect, Layer, Option } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import {
  Task,
  TaskTransitionError,
  isValidTaskTransition,
  type TaskStatus,
} from "../domain/task.js"
import {
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskStopped,
  TaskDeleted,
} from "../domain/event.js"
import type { AgentName } from "../domain/agent.js"
import type { TaskId, SessionId, BranchId } from "../domain/ids.js"
import { TaskStorage, type TaskStorageService } from "./task-tools-storage.js"

// Extension-owned task service. Present only when @gent/task-tools is loaded.
// Pure state management — no execution, no fibers, no agent spawning.

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
  }) => Effect.Effect<Task>
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
  }) => Effect.Effect<Task, never, EventPublisher>

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
  ) => Effect.Effect<Task | undefined, TaskTransitionError, EventPublisher>

  readonly remove: (id: TaskId) => Effect.Effect<void, never, EventPublisher>

  readonly addDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly removeDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly getDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>>
}

export class TaskService extends Context.Service<TaskService, TaskServiceApi>()(
  "@gent/core/src/extensions/task-tools-service/TaskService",
) {
  /** No-op TaskService returned when @gent/task-tools is disabled (TaskStorage absent) */
  private static readonly Noop: TaskServiceFallbackApi = {
    create: () => Effect.die("TaskStorage not available — @gent/task-tools is disabled"),
    get: () => Effect.void as Effect.Effect<Task | undefined>,
    list: () => Effect.succeed([] as ReadonlyArray<Task>),
    update: () => Effect.void as Effect.Effect<Task | undefined>,
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
                const eventPublisher = yield* EventPublisher
                const id = Bun.randomUUIDv7() as TaskId
                const now = yield* DateTime.nowAsDate
                const task = new Task({
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
                yield* eventPublisher.publish(
                  new TaskCreated({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    taskId: id,
                    subject: params.subject,
                  }),
                )
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
                const eventPublisher = yield* EventPublisher
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
                  if (fields.status === "completed") {
                    yield* eventPublisher.publish(
                      new TaskCompleted({
                        sessionId: updated.sessionId,
                        branchId: updated.branchId,
                        taskId: id,
                        owner: updated.owner,
                      }),
                    )
                  } else if (fields.status === "failed") {
                    const error =
                      updated.metadata !== null &&
                      updated.metadata !== undefined &&
                      typeof updated.metadata === "object" &&
                      "error" in updated.metadata &&
                      typeof updated.metadata.error === "string"
                        ? updated.metadata.error
                        : undefined
                    yield* eventPublisher.publish(
                      new TaskFailed({
                        sessionId: updated.sessionId,
                        branchId: updated.branchId,
                        taskId: id,
                        ...(error !== undefined ? { error } : {}),
                      }),
                    )
                  } else if (fields.status === "stopped") {
                    yield* eventPublisher.publish(
                      new TaskStopped({
                        sessionId: updated.sessionId,
                        branchId: updated.branchId,
                        taskId: id,
                      }),
                    )
                  } else {
                    yield* eventPublisher.publish(
                      new TaskUpdated({
                        sessionId: updated.sessionId,
                        branchId: updated.branchId,
                        taskId: id,
                        status: fields.status,
                      }),
                    )
                  }
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
                const eventPublisher = yield* EventPublisher
                const existing = yield* storage.getTask(id).pipe(Effect.orDie)
                if (existing === undefined) {
                  yield* storage.deleteTask(id).pipe(Effect.orDie)
                  return
                }
                yield* storage.deleteTask(id).pipe(Effect.orDie)
                yield* eventPublisher
                  .publish(
                    new TaskDeleted({
                      sessionId: existing.sessionId,
                      branchId: existing.branchId,
                      taskId: id,
                    }),
                  )
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
