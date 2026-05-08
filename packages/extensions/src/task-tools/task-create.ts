import { Effect, Schema } from "effect"
import { tool, AgentName, ToolNeeds } from "@gent/core/extensions/api"
import { TaskId, TaskStatus } from "./domain.js"
import { TaskService } from "../task-tools-service.js"

export const TaskCreateParams = Schema.Struct({
  subject: Schema.String.annotate({ description: "Brief task title in imperative form" }),
  description: Schema.optionalKey(
    Schema.String.annotate({ description: "Detailed description of what needs to be done" }),
  ),
  agent: Schema.optionalKey(AgentName.annotate({ description: "Agent type to execute this task" })),
  prompt: Schema.optionalKey(
    Schema.String.annotate({ description: "Execution prompt for the agent" }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({ description: "Working directory for execution" }),
  ),
  blockedBy: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Task IDs that must complete before this one can start",
    }),
  ),
})

export const TaskCreateResult = Schema.Struct({
  taskId: TaskId,
  subject: Schema.String,
  status: TaskStatus,
  blockedBy: Schema.optional(Schema.Array(Schema.String)),
})

export const TaskCreateTool = tool({
  id: "task_create",
  needs: [ToolNeeds.write("task")],
  description:
    "Create a durable task with optional dependencies. Tasks persist across turns and can be run in the background. Set agent + prompt for executable tasks.",
  params: TaskCreateParams,
  output: TaskCreateResult,
  execute: Effect.fn("TaskCreateTool.execute")(function* (params, ctx) {
    const taskService = yield* TaskService
    const task = yield* taskService.create({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      subject: params.subject,
      description: params.description,
      agentType: params.agent,
      prompt: params.prompt,
      cwd: params.cwd,
    })

    if (params.blockedBy !== undefined) {
      for (const depId of params.blockedBy) {
        yield* taskService.addDep(task.id, TaskId.make(depId))
      }
    }

    return {
      taskId: task.id,
      subject: task.subject,
      status: task.status,
      ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
    }
  }),
})
