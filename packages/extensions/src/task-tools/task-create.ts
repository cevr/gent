import { Effect, Schema } from "effect"
import { defineTool, AgentName, TaskId } from "@gent/core/extensions/api"
import { TaskProtocol } from "../task-tools-protocol.js"

export const TaskCreateParams = Schema.Struct({
  subject: Schema.String.annotate({ description: "Brief task title in imperative form" }),
  description: Schema.optional(
    Schema.String.annotate({ description: "Detailed description of what needs to be done" }),
  ),
  agent: Schema.optional(AgentName.annotate({ description: "Agent type to execute this task" })),
  prompt: Schema.optional(
    Schema.String.annotate({ description: "Execution prompt for the agent" }),
  ),
  cwd: Schema.optional(Schema.String.annotate({ description: "Working directory for execution" })),
  blockedBy: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Task IDs that must complete before this one can start",
    }),
  ),
})

export const TaskCreateTool = defineTool({
  name: "task_create",
  concurrency: "parallel",
  description:
    "Create a durable task with optional dependencies. Tasks persist across turns and can be run in the background. Set agent + prompt for executable tasks.",
  params: TaskCreateParams,
  execute: Effect.fn("TaskCreateTool.execute")(function* (params, ctx) {
    const task = yield* ctx.extension.ask(
      TaskProtocol.CreateTask({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        subject: params.subject,
        description: params.description,
        agentType: params.agent,
        prompt: params.prompt,
        cwd: params.cwd,
      }),
      ctx.branchId,
    )

    if (params.blockedBy !== undefined) {
      for (const depId of params.blockedBy) {
        yield* ctx.extension.ask(
          TaskProtocol.AddDependency({ taskId: task.id, blockedById: TaskId.of(depId) }),
          ctx.branchId,
        )
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
