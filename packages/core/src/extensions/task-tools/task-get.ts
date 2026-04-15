import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import { TaskId } from "../../domain/ids.js"
import { TaskProtocol } from "../task-tools-protocol.js"

export const TaskGetParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to get details for" }),
})

export const TaskGetTool = defineTool({
  name: "task_get",
  concurrency: "parallel",
  idempotent: true,
  description: "Get full details of a task including description, dependencies, and owner session.",
  params: TaskGetParams,
  execute: Effect.fn("TaskGetTool.execute")(function* (params, ctx) {
    const task = yield* ctx.extension.ask(
      TaskProtocol.GetTask({ taskId: TaskId.of(params.taskId) }),
      ctx.branchId,
    )
    if (task == null) {
      return { error: `Task not found: ${params.taskId}` }
    }

    const deps = yield* ctx.extension.ask(
      TaskProtocol.GetDependencies({ taskId: TaskId.of(params.taskId) }),
      ctx.branchId,
    )

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
