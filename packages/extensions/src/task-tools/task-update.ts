import { Effect, Schema } from "effect"
import { tool } from "@gent/core/extensions/api"
import { TaskId, TaskStatus } from "./domain.js"
import { TaskService } from "../task-tools-service.js"

export const TaskUpdateParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to update" }),
  status: Schema.optionalKey(
    Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]).annotate({
      description: "New status",
    }),
  ),
  description: Schema.optionalKey(Schema.String.annotate({ description: "Updated description" })),
})

export const TaskUpdateResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  id: Schema.optional(TaskId),
  subject: Schema.optional(Schema.String),
  status: Schema.optional(TaskStatus),
})

export const TaskUpdateTool = tool({
  id: "task_update",
  description:
    "Update a task's status or description. Use status 'completed' to mark done, 'failed' for errors.",
  params: TaskUpdateParams,
  output: TaskUpdateResult,
  execute: Effect.fn("TaskUpdateTool.execute")(function* (params: typeof TaskUpdateParams.Type) {
    const taskService = yield* TaskService
    const updated = yield* taskService.update(TaskId.make(params.taskId), {
      status: params.status,
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
