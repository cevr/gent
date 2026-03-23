import { ServiceMap, Effect, Layer } from "effect"
import { Task, type TaskStatus } from "../domain/task.js"
import {
  EventStore,
  TaskCreated,
  TaskUpdated,
  TaskCompleted,
  TaskFailed,
  TaskDeleted,
} from "../domain/event.js"
import { SubagentRunnerService, type AgentName } from "../domain/agent.js"
import { ExtensionRegistry } from "./extensions/registry.js"
import type { TaskId, SessionId, BranchId } from "../domain/ids.js"
import { Storage } from "../storage/sqlite-storage.js"

// TaskService

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

  readonly run: (id: TaskId) => Effect.Effect<{
    taskId: TaskId
    status: string
    sessionId?: SessionId
    branchId?: BranchId
  }>

  readonly addDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly removeDep: (taskId: TaskId, blockedById: TaskId) => Effect.Effect<void>
  readonly getDeps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TaskId>>
}

export class TaskService extends ServiceMap.Service<TaskService, TaskServiceApi>()(
  "@gent/runtime/src/task-service/TaskService",
) {
  static Live: Layer.Layer<
    TaskService,
    never,
    Storage | EventStore | SubagentRunnerService | ExtensionRegistry
  > = Layer.effect(
    TaskService,
    Effect.gen(function* () {
      const storage = yield* Storage
      const eventStore = yield* EventStore
      const runner = yield* SubagentRunnerService
      const extensionRegistry = yield* ExtensionRegistry

      const runTaskInternal: (taskId: TaskId, task: Task) => Effect.Effect<void> = (taskId, task) =>
        Effect.gen(function* () {
          const agent = yield* extensionRegistry.getAgent(task.agentType ?? "explore")
          if (agent === undefined) {
            yield* storage
              .updateTask(taskId, { status: "failed" })
              .pipe(Effect.catchEager(() => Effect.void))
            yield* eventStore
              .publish(
                new TaskFailed({
                  sessionId: task.sessionId,
                  branchId: task.branchId,
                  taskId,
                  error: `Unknown agent: ${task.agentType}`,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))
            return
          }

          // Status already set to in_progress by run() before forking
          const parentSessionId = task.sessionId
          const parentBranchId = task.branchId

          // Run subagent
          const result = yield* runner.run({
            agent,
            prompt: task.prompt ?? task.subject,
            parentSessionId,
            parentBranchId,
            cwd: task.cwd ?? process.cwd(),
          })

          if (result._tag === "success") {
            yield* storage
              .updateTask(taskId, { status: "completed", owner: result.sessionId })
              .pipe(Effect.catchEager(() => Effect.void))
            yield* eventStore
              .publish(
                new TaskCompleted({
                  sessionId: parentSessionId,
                  branchId: parentBranchId,
                  taskId,
                  owner: result.sessionId,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))

            // Check dependent tasks for auto-run
            yield* checkAndRunDependents(taskId).pipe(Effect.catchEager(() => Effect.void))
          } else {
            yield* storage
              .updateTask(taskId, { status: "failed", metadata: { error: result.error } })
              .pipe(Effect.catchEager(() => Effect.void))
            yield* eventStore
              .publish(
                new TaskFailed({
                  sessionId: parentSessionId,
                  branchId: parentBranchId,
                  taskId,
                  error: result.error,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))
          }
        }).pipe(Effect.catchEager(() => Effect.void))

      const checkAndRunDependents: (completedTaskId: TaskId) => Effect.Effect<void> = (
        completedTaskId,
      ) =>
        Effect.gen(function* () {
          const dependents = yield* storage.getTaskDependents(completedTaskId)
          for (const depTaskId of dependents) {
            const depTask = yield* storage.getTask(depTaskId)
            if (depTask === undefined || depTask.status !== "pending") continue
            if (depTask.agentType === undefined || depTask.prompt === undefined) continue

            // Check if all blockers are done
            const blockers = yield* storage.getTaskDeps(depTaskId)
            const allDone = yield* Effect.forEach(blockers, (blockerId) =>
              storage
                .getTask(blockerId)
                .pipe(
                  Effect.map(
                    (t) => t === undefined || t.status === "completed" || t.status === "failed",
                  ),
                ),
            )
            if (allDone.every(Boolean)) {
              // Atomically claim before forking
              yield* storage
                .updateTask(depTaskId, { status: "in_progress" })
                .pipe(Effect.catchEager(() => Effect.void))
              yield* eventStore
                .publish(
                  new TaskUpdated({
                    sessionId: depTask.sessionId,
                    branchId: depTask.branchId,
                    taskId: depTaskId,
                    status: "in_progress",
                  }),
                )
                .pipe(Effect.catchEager(() => Effect.void))
              yield* Effect.forkDetach(runTaskInternal(depTaskId, depTask))
            }
          }
        }).pipe(Effect.catchEager(() => Effect.void))

      return {
        create: (params) =>
          Effect.gen(function* () {
            const id = Bun.randomUUIDv7() as TaskId
            const now = new Date()
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
            yield* eventStore.publish(
              new TaskCreated({
                sessionId: params.sessionId,
                branchId: params.branchId,
                taskId: id,
                subject: params.subject,
              }),
            )
            return task
          }).pipe(Effect.orDie),

        get: (id) => storage.getTask(id).pipe(Effect.orDie),

        list: (sessionId, branchId) => storage.listTasks(sessionId, branchId).pipe(Effect.orDie),

        update: (id, fields) =>
          Effect.gen(function* () {
            const updated = yield* storage.updateTask(id, fields)
            if (updated !== undefined && fields.status !== undefined) {
              if (fields.status === "completed") {
                yield* eventStore.publish(
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
                yield* eventStore.publish(
                  new TaskFailed({
                    sessionId: updated.sessionId,
                    branchId: updated.branchId,
                    taskId: id,
                    ...(error !== undefined ? { error } : {}),
                  }),
                )
              } else {
                yield* eventStore.publish(
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

        remove: (id) =>
          Effect.gen(function* () {
            const existing = yield* storage.getTask(id).pipe(Effect.orDie)
            if (existing === undefined) {
              yield* storage.deleteTask(id).pipe(Effect.orDie)
              return
            }
            yield* storage.deleteTask(id).pipe(Effect.orDie)
            yield* eventStore
              .publish(
                new TaskDeleted({
                  sessionId: existing.sessionId,
                  branchId: existing.branchId,
                  taskId: id,
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))
          }),

        run: (id) =>
          Effect.gen(function* () {
            const task = yield* storage.getTask(id).pipe(Effect.orDie)
            if (task === undefined) {
              return { taskId: id, status: "not_found" }
            }
            if (task.status !== "pending") {
              return { taskId: id, status: task.status }
            }

            // Atomically claim before forking — prevents double-run race
            yield* storage.updateTask(id, { status: "in_progress" }).pipe(Effect.orDie)
            yield* eventStore
              .publish(
                new TaskUpdated({
                  sessionId: task.sessionId,
                  branchId: task.branchId,
                  taskId: id,
                  status: "in_progress",
                }),
              )
              .pipe(Effect.catchEager(() => Effect.void))

            yield* Effect.forkDetach(runTaskInternal(id, task))
            return { taskId: id, status: "running" }
          }),

        addDep: (taskId, blockedById) => storage.addTaskDep(taskId, blockedById).pipe(Effect.orDie),
        removeDep: (taskId, blockedById) =>
          storage.removeTaskDep(taskId, blockedById).pipe(Effect.orDie),
        getDeps: (taskId) => storage.getTaskDeps(taskId).pipe(Effect.orDie),
      }
    }),
  )
}
