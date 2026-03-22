import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core/domain/tool.js"
import type { TaskId } from "@gent/core/domain/ids.js"
import { TaskService } from "@gent/runtime"

export const TaskRunParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to run in the background" }),
})

export const TaskRunTool = defineTool({
  name: "task_run",
  concurrency: "parallel",
  description:
    "Run a task in the background. The task must have agent + prompt set. Returns immediately with status 'running'. Use task_list or task_get to check progress.",
  params: TaskRunParams,
  execute: Effect.fn("TaskRunTool.execute")(function* (params) {
    const taskService = yield* TaskService

    const result = yield* taskService.run(params.taskId as TaskId)

    return {
      taskId: result.taskId,
      status: result.status,
      ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    }
  }),
})
