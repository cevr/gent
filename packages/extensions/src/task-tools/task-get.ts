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

export const TaskGetParams = Schema.Struct({
  taskId: Schema.String.annotate({ description: "Task ID to get details for" }),
})

export const TaskGetResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  id: Schema.optional(TaskId),
  subject: Schema.optional(Schema.String),
  status: Schema.optional(TaskStatus),
  description: Schema.optional(Schema.String),
  agent: Schema.optional(AgentName),
  prompt: Schema.optional(Schema.String),
  owner: Schema.optional(SessionId),
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  blockedBy: Schema.optional(Schema.Array(TaskId)),
  createdAt: Schema.optional(Schema.Number),
})

export const TaskGetTool = tool({
  id: "task_get",
  needs: [ToolNeeds.read("task")],
  description: "Get full details of a task including description, dependencies, and owner session.",
  params: TaskGetParams,
  output: TaskGetResult,
  execute: Effect.fn("TaskGetTool.execute")(function* (params) {
    const taskId = TaskId.make(params.taskId)
    const taskService = yield* TaskService
    const task = yield* taskService.get(taskId)
    if (task == null) {
      return { error: `Task not found: ${params.taskId}` }
    }

    const deps = yield* taskService.getDeps(taskId)

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
