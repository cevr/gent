import { Effect, Schema } from "effect"
import { tool } from "@gent/core/extensions/api"
import { TaskListRef } from "./queries.js"

export const TaskListParams = Schema.Struct({})

export const TaskListTool = tool({
  id: "task_list",
  idempotent: true,
  description: "List all tasks for the current session and branch, sorted by creation time.",
  params: TaskListParams,
  execute: Effect.fn("TaskListTool.execute")(function* (_params, ctx) {
    const tasks = yield* ctx.extension.query(TaskListRef, {})

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
