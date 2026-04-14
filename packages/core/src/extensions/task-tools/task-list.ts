import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import { TaskProtocol } from "../task-tools-protocol.js"

export const TaskListParams = Schema.Struct({})

export const TaskListTool = defineTool({
  name: "task_list",
  concurrency: "parallel",
  idempotent: true,
  description: "List all tasks for the current session and branch, sorted by creation time.",
  params: TaskListParams,
  execute: Effect.fn("TaskListTool.execute")(function* (_params, ctx) {
    const tasks = yield* ctx.extension.ask(
      TaskProtocol.ListTasks({ sessionId: ctx.sessionId, branchId: ctx.branchId }),
      ctx.branchId,
    )

    if (tasks.length === 0) {
      return { tasks: [], summary: "No tasks" }
    }

    const summary = {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      in_progress: tasks.filter((t) => t.status === "in_progress").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    }

    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        ...(t.owner !== undefined ? { owner: t.owner } : {}),
        ...(t.agentType !== undefined ? { agent: t.agentType } : {}),
      })),
      summary,
    }
  }),
})
