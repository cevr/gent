import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"
import type { TaskId } from "../domain/ids.js"
import { TaskService } from "../runtime/task-service.js"

export const TaskStopParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to stop" }),
})

export const TaskStopTool = defineTool({
  name: "task_stop",
  action: "state",
  concurrency: "parallel",
  idempotent: true,
  description:
    "Stop a running or pending task. Interrupts the task's agent fiber and sets status to stopped.",
  params: TaskStopParams,
  execute: Effect.fn("TaskStopTool.execute")(function* (params) {
    const taskService = yield* TaskService

    const updated = yield* taskService.stop(params.taskId as TaskId)
    if (updated === undefined) {
      return { error: `Task not found: ${params.taskId}` }
    }

    return {
      id: updated.id,
      status: updated.status,
      subject: updated.subject,
    }
  }),
})
