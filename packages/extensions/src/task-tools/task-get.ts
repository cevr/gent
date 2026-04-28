import { Effect, Schema } from "effect"
import { tool, ref, TaskId, ToolNeeds } from "@gent/core/extensions/api"
import { TaskGetDepsRequest, TaskGetRequest } from "./requests.js"

export const TaskGetParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to get details for" }),
})

export const TaskGetTool = tool({
  id: "task_get",
  needs: [ToolNeeds.read("task")],
  description: "Get full details of a task including description, dependencies, and owner session.",
  params: TaskGetParams,
  execute: Effect.fn("TaskGetTool.execute")(function* (params, ctx) {
    const taskId = TaskId.make(params.taskId)
    const task = yield* ctx.extension.request(ref(TaskGetRequest), { taskId })
    if (task == null) {
      return { error: `Task not found: ${params.taskId}` }
    }

    const deps = yield* ctx.extension.request(ref(TaskGetDepsRequest), { taskId })

    return {
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.description !== undefined ? { description: task.description } : {}),
      ...(task.agentType !== undefined ? { agent: task.agentType } : {}),
      ...(task.prompt !== undefined ? { prompt: task.prompt } : {}),
      ...(task.owner !== undefined ? { owner: task.owner } : {}),
      ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
      ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
      ...(deps.length > 0 ? { blockedBy: deps } : {}),
      createdAt: task.createdAt.getTime(),
    }
  }),
})
