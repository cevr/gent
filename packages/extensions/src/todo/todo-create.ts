import { Effect, Schema } from "effect"
import { tool, AgentName, ToolNeeds } from "@gent/core/extensions/api"
import { TodoId, TodoStatus } from "./domain.js"
import { TodoService } from "../todo-service.js"

export const TodoCreateParams = Schema.Struct({
  parentId: Schema.optionalKey(
    Schema.String.annotate({ description: "Optional parent todo ID for nested todo tracking" }),
  ),
  subject: Schema.String.annotate({ description: "Brief todo title in imperative form" }),
  description: Schema.optionalKey(
    Schema.String.annotate({ description: "Detailed description of what needs to be done" }),
  ),
  agent: Schema.optionalKey(AgentName.annotate({ description: "Agent type to execute this todo" })),
  prompt: Schema.optionalKey(
    Schema.String.annotate({ description: "Execution prompt for the agent" }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({ description: "Working directory for execution" }),
  ),
  blockedBy: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Todo IDs that must complete before this one can start",
    }),
  ),
})

export const TodoCreateResult = Schema.Struct({
  todoId: TodoId,
  parentId: Schema.optional(TodoId),
  subject: Schema.String,
  status: TodoStatus,
  blockedBy: Schema.optional(Schema.Array(Schema.String)),
})

export const TodoCreateTool = tool({
  id: "todo_create",
  needs: [ToolNeeds.write("todo")],
  description:
    "Create a durable todo with optional dependencies. Todos persist across turns and can be run in the background. Set agent + prompt for executable todos.",
  params: TodoCreateParams,
  output: TodoCreateResult,
  execute: Effect.fn("TodoCreateTool.execute")(function* (params, ctx) {
    const todoService = yield* TodoService
    const todo = yield* todoService.create({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      parentId: params.parentId !== undefined ? TodoId.make(params.parentId) : undefined,
      subject: params.subject,
      description: params.description,
      agentType: params.agent,
      prompt: params.prompt,
      cwd: params.cwd,
    })

    if (params.blockedBy !== undefined) {
      for (const depId of params.blockedBy) {
        yield* todoService.addDep(todo.id, TodoId.make(depId))
      }
    }

    return {
      todoId: todo.id,
      ...(todo.parentId !== undefined ? { parentId: todo.parentId } : {}),
      subject: todo.subject,
      status: todo.status,
      ...(params.blockedBy !== undefined ? { blockedBy: params.blockedBy } : {}),
    }
  }),
})
