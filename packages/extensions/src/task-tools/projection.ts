/**
 * TaskProjection — derive task list from `TaskStorage` on demand.
 *
 * Replaces the actor-as-mirror pattern that maintained `TaskListState.tasks`
 * by reducing every TaskCreated/TaskUpdated/TaskCompleted/etc. event. The
 * source of truth is on-disk in `TaskStorage` already; the actor's mirror was
 * bookkeeping cosplay (`derive-do-not-create-states`).
 *
 * Surfaces:
 *   - `ui` — emits `{ tasks: TaskEntry[] }` matching `TaskUiModel` so the TUI
 *           snapshot reader is unchanged
 *
 * @module
 */
import { Effect } from "effect"
import { type ProjectionContribution, ProjectionError, type Task } from "@gent/core/extensions/api"
import { TaskStorage } from "../task-tools-storage.js"
import { TaskUiModel, type TaskEntry, type TaskUiModel as TaskUiModelType } from "./identity.js"

const taskToEntry = (task: Task): TaskEntry => ({
  id: task.id,
  subject: task.subject,
  status: task.status,
})

/**
 * Read-only projection of the task list. Queries `TaskStorage` per session,
 * emits a UI snapshot keyed at the extension level.
 */
export const TaskProjection: ProjectionContribution<TaskUiModelType, TaskStorage> = {
  id: "task-list",
  query: (ctx) =>
    Effect.gen(function* () {
      const storage = yield* TaskStorage
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
  ui: {
    schema: TaskUiModel,
    project: (value) => value,
  },
}
