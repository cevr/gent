import { Effect, Schema } from "effect"
import { defineTool, TaskId, type TaskStatus } from "@gent/core/extensions/api"
import { TaskUpdateRef } from "./mutations.js"

export const TaskUpdateParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to update" }),
  status: Schema.optional(
    Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]).annotate({
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
  execute: Effect.fn("TaskUpdateTool.execute")(function* (params, ctx) {
    const updated = yield* ctx.extension.mutate(TaskUpdateRef, {
      taskId: TaskId.of(params.taskId),
      status: params.status as TaskStatus | undefined,
      description: params.description,
    })

    if (updated == null) {
      return { error: `Task not found: ${params.taskId}` }
    }

    return {
      id: updated.id,
      subject: updated.subject,
      status: updated.status,
    }
  }),
})
