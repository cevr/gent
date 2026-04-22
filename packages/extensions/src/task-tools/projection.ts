/**
 * TaskProjection — derive task list from `TaskStorage` on demand.
 *
 * The projection itself contributes no agent-loop surface (no prompt or
 * policy). It exists only to register the task-tools extension as having
 * observable state, so the event publisher emits `ExtensionStateChanged`
 * pulses that the TUI widget subscribes to. Clients fetch the actual task
 * list via the typed `TaskListRequest` (`client.extension.request`).
 *
 * @module
 */
import { Effect } from "effect"
import { type ProjectionContribution, ProjectionError, type Task } from "@gent/core/extensions/api"
import { TaskStorageReadOnly } from "../task-tools-storage.js"
import { type TaskEntry, type TaskUiModel as TaskUiModelType } from "./identity.js"

const taskToEntry = (task: Task): TaskEntry => ({
  id: task.id,
  subject: task.subject,
  status: task.status,
})

export const TaskProjection: ProjectionContribution<TaskUiModelType, TaskStorageReadOnly> = {
  id: "task-list",
  query: (ctx) =>
    Effect.gen(function* () {
      const storage = yield* TaskStorageReadOnly
      const tasks = yield* storage.listTasks(ctx.sessionId, ctx.branchId).pipe(
        Effect.catchEager((error) =>
          Effect.fail(
            new ProjectionError({
              projectionId: "task-list",
              reason: `TaskStorage.listTasks failed: ${error.message}`,
            }),
          ),
        ),
      )
      return { tasks: tasks.map(taskToEntry) }
    }),
}
