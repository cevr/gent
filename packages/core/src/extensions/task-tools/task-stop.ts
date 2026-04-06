import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import type { TaskId } from "../../domain/ids.js"
import { TaskProtocol } from "../task-tools-protocol.js"

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
  execute: Effect.fn("TaskStopTool.execute")(function* (params, ctx) {
    const updated = yield* ctx.extension.ask(
      TaskProtocol.StopTask({ taskId: params.taskId as TaskId }),
      ctx.branchId,
    )
    if (updated == null) {
      return { error: `Task not found: ${params.taskId}` }
    }

    return {
      id: updated.id,
      status: updated.status,
      subject: updated.subject,
    }
  }),
})
