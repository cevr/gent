import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import type { TaskStatus } from "../../domain/task.js"
import type { TaskId } from "../../domain/ids.js"
import { TaskProtocol } from "../task-tools-protocol.js"

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
  action: "state",
  concurrency: "parallel",
  description:
    "Update a task's status or description. Use status 'completed' to mark done, 'failed' for errors.",
  params: TaskUpdateParams,
  execute: Effect.fn("TaskUpdateTool.execute")(function* (params, ctx) {
    const updated = yield* ctx.extensions.ask(
      TaskProtocol.UpdateTask({
        taskId: params.taskId as TaskId,
        status: params.status as TaskStatus | undefined,
        description: params.description,
      }),
      ctx.branchId,
    )

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
