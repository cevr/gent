import { Effect, Schema } from "effect"
import { tool, ref, TaskId, type TaskStatus } from "@gent/core/extensions/api"
import { TaskUpdateRequest } from "./requests.js"

export const TaskUpdateParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to update" }),
  status: Schema.optional(
    Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]).annotate({
      description: "New status",
    }),
  ),
  description: Schema.optional(Schema.String.annotate({ description: "Updated description" })),
})

export const TaskUpdateTool = tool({
  id: "task_update",
  description:
    "Update a task's status or description. Use status 'completed' to mark done, 'failed' for errors.",
  params: TaskUpdateParams,
  execute: Effect.fn("TaskUpdateTool.execute")(function* (params, ctx) {
    const updated = yield* ctx.extension.request(ref(TaskUpdateRequest), {
      taskId: TaskId.make(params.taskId),
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
