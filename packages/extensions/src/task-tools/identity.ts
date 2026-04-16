/**
 * Task-tools identity + UI schemas.
 *
 * Shared between the projection (UI snapshot model) and the
 * client-side TUI snapshot reader. Kept separate from queries/mutations to
 * avoid circular imports — the projection imports from here; queries/mutations
 * import their own schemas from @gent/core/extensions/api.
 *
 * @module
 */
import { Schema } from "effect"
import { TaskId, TaskStatus } from "@gent/core/extensions/api"

export const TASK_TOOLS_EXTENSION_ID = "@gent/task-tools"

/** Schema for individual task entries in the UI snapshot (subset of full Task). */
export const TaskEntrySchema = Schema.Struct({
  id: TaskId,
  subject: Schema.String,
  status: TaskStatus,
})
export type TaskEntry = typeof TaskEntrySchema.Type

/** Schema for the task-tools extension UI snapshot model. */
export const TaskUiModel = Schema.Struct({
  tasks: Schema.Array(TaskEntrySchema),
})
export type TaskUiModel = typeof TaskUiModel.Type
