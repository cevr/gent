import { Effect, Schema } from "effect"
import { tool, TaskId } from "@gent/core/extensions/api"
import { TaskGetDepsRef, TaskGetRef } from "./requests.js"

export const TaskGetParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to get details for" }),
})

export const TaskGetTool = tool({
  id: "task_get",
  idempotent: true,
  description: "Get full details of a task including description, dependencies, and owner session.",
  params: TaskGetParams,
  execute: Effect.fn("TaskGetTool.execute")(function* (params, ctx) {
    const taskId = TaskId.of(params.taskId)
    const task = yield* ctx.extension.request(TaskGetRef, { taskId })
    if (task == null) {
      return { error: `Task not found: ${params.taskId}` }
    }

    const deps = yield* ctx.extension.request(TaskGetDepsRef, { taskId })

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
