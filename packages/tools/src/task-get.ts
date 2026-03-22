import { Effect, Schema } from "effect"
import { defineTool } from "@gent/core/domain/tool.js"
import type { TaskId } from "@gent/core/domain/ids.js"
import { TaskService } from "@gent/runtime"

export const TaskGetParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to get details for" }),
})

export const TaskGetTool = defineTool({
  name: "task_get",
  concurrency: "parallel",
  idempotent: true,
  description: "Get full details of a task including description, dependencies, and owner session.",
  params: TaskGetParams,
  execute: Effect.fn("TaskGetTool.execute")(function* (params) {
    const taskService = yield* TaskService

    const task = yield* taskService.get(params.taskId as TaskId)
    if (task === undefined) {
      return { error: `Task not found: ${params.taskId}` }
    }

    const deps = yield* taskService.getDeps(params.taskId as TaskId)

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
