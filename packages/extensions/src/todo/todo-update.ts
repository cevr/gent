import { Effect, Schema } from "effect"
import { tool, ToolNeeds } from "@gent/core/extensions/api"
import { TodoId, TodoStatus, TodoTransitionError } from "./domain.js"
import { TodoService } from "../todo-service.js"

export const TodoUpdateParams = Schema.Struct({
  todoId: Schema.String.annotate({ description: "Todo ID to update" }),
  status: Schema.optionalKey(
    Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]).annotate({
      description: "New status",
    }),
  ),
  parentId: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.annotate({
        description: "Parent todo ID for nesting, or null to move to the root",
      }),
    ),
  ),
  description: Schema.optionalKey(Schema.String.annotate({ description: "Updated description" })),
})

export const TodoUpdateResult = Schema.Struct({
  error: Schema.optional(Schema.String),
  id: Schema.optional(TodoId),
  subject: Schema.optional(Schema.String),
  status: Schema.optional(TodoStatus),
  parentId: Schema.optional(TodoId),
})

export const TodoUpdateTool = tool({
  id: "todo_update",
  needs: [ToolNeeds.write("todo")],
  description:
    "Update a todo's status or description. Use status 'completed' to mark done, 'failed' for errors.",
  params: TodoUpdateParams,
  output: TodoUpdateResult,
  execute: Effect.fn("TodoUpdateTool.execute")(function* (params: typeof TodoUpdateParams.Type) {
    const todoService = yield* TodoService
    const updated = yield* todoService
      .update(TodoId.make(params.todoId), {
        status: params.status,
        parentId:
          params.parentId !== undefined && params.parentId !== null
            ? TodoId.make(params.parentId)
            : params.parentId,
        description: params.description,
      })
      .pipe(
        Effect.catchIf(Schema.is(TodoTransitionError), (error) =>
          Effect.succeed({ error: error.message }),
        ),
      )

    if (updated == null) {
      return { error: `Todo not found: ${params.todoId}` }
    }
    if ("error" in updated) return updated

    return {
      id: updated.id,
      subject: updated.subject,
      status: updated.status,
      parentId: updated.parentId,
    }
  }),
})
