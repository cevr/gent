import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import type { TaskStatus } from "../domain/task.js"
import { TaskService } from "../runtime/task-service.js"

export const TaskUpdateParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to update" }),
  status: Schema.optional(
    Schema.Literals(["pending", "in_progress", "completed", "failed"]).annotate({
      description: "New status",
    }),
  ),
  description: Schema.optional(Schema.String.annotate({ description: "Updated description" })),
})

export const TaskUpdateTool = defineTool({
  name: "task_update",
  concurrency: "parallel",
  description:
    "Update a task's status or description. Use status 'completed' to mark done, 'failed' for errors.",
  params: TaskUpdateParams,
  execute: Effect.fn("TaskUpdateTool.execute")(function* (params) {
    const taskService = yield* TaskService

    const fields: Partial<{ status: TaskStatus; description: string | null }> = {}
    if (params.status !== undefined) fields.status = params.status
    if (params.description !== undefined) fields.description = params.description

    const updated = yield* taskService.update(
      params.taskId as Parameters<typeof taskService.update>[0],
      fields,
    )

    if (updated === undefined) {
      return { error: `Task not found: ${params.taskId}` }
    }

    return {
      id: updated.id,
      subject: updated.subject,
      status: updated.status,
    }
  }),
})
