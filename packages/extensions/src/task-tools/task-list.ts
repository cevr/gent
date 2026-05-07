import { Effect, Schema } from "effect"
import {
  tool,
  AgentName,
  SessionId,
  TaskId,
  TaskStatus,
  ToolNeeds,
} from "@gent/core/extensions/api"
import { TaskService } from "../task-tools-service.js"

export const TaskListParams = Schema.Struct({})

export const TaskListResult = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      id: TaskId,
      subject: Schema.String,
      status: TaskStatus,
      owner: Schema.optional(SessionId),
      agent: Schema.optional(AgentName),
    }),
  ),
  summary: Schema.Union([
    Schema.String,
    Schema.Struct({
      total: Schema.Number,
      pending: Schema.Number,
      in_progress: Schema.Number,
      completed: Schema.Number,
      failed: Schema.Number,
    }),
  ]),
})

export const TaskListTool = tool({
  id: "task_list",
  needs: [ToolNeeds.read("task")],
  description: "List all tasks for the current session and branch, sorted by creation time.",
  params: TaskListParams,
  output: TaskListResult,
  execute: Effect.fn("TaskListTool.execute")(function* (_params, ctx) {
    const taskService = yield* TaskService
    const tasks = yield* taskService.list(ctx.sessionId, ctx.branchId)

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
