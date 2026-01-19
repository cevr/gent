import { Schema } from "effect"

// Todo Status

export const TodoStatus = Schema.Literal("pending", "in_progress", "completed")
export type TodoStatus = typeof TodoStatus.Type

// Todo Priority

export const TodoPriority = Schema.Literal("high", "medium", "low")
export type TodoPriority = typeof TodoPriority.Type

// Todo Item

export class TodoItem extends Schema.Class<TodoItem>("TodoItem")({
  id: Schema.String,
  content: Schema.String,
  status: TodoStatus,
  priority: Schema.optional(TodoPriority),
  createdAt: Schema.DateFromNumber,
  updatedAt: Schema.DateFromNumber,
}) {}
