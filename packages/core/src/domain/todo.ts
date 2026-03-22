import { Schema } from "effect"
import { DateFromNumber } from "./message"

// Todo Status

export const TodoStatus = Schema.Literals(["pending", "in_progress", "completed"])
export type TodoStatus = typeof TodoStatus.Type

// Todo Priority

export const TodoPriority = Schema.Literals(["high", "medium", "low"])
export type TodoPriority = typeof TodoPriority.Type

// Todo Item

export class TodoItem extends Schema.Class<TodoItem>("TodoItem")({
  id: Schema.String,
  content: Schema.String,
  status: TodoStatus,
  priority: Schema.optional(TodoPriority),
  createdAt: DateFromNumber,
  updatedAt: DateFromNumber,
}) {}
