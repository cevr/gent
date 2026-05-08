import { Schema } from "effect"
import { AgentName, BranchId, DateFromNumber, SessionId } from "@gent/core/extensions/api"

export const TodoId = Schema.String.pipe(Schema.brand("TodoId"))
export type TodoId = typeof TodoId.Type

export const TodoStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "stopped",
])
export type TodoStatus = typeof TodoStatus.Type

const VALID_TRANSITIONS: ReadonlyMap<TodoStatus, ReadonlySet<TodoStatus>> = new Map([
  ["pending", new Set<TodoStatus>(["in_progress", "failed", "stopped"])],
  ["in_progress", new Set<TodoStatus>(["completed", "failed", "stopped"])],
  ["completed", new Set<TodoStatus>()],
  ["failed", new Set<TodoStatus>()],
  ["stopped", new Set<TodoStatus>()],
])

export const isValidTodoTransition = (from: TodoStatus, to: TodoStatus): boolean =>
  VALID_TRANSITIONS.get(from)?.has(to) === true

export class TodoTransitionError extends Schema.TaggedErrorClass<TodoTransitionError>()(
  "TodoTransitionError",
  {
    message: Schema.String,
    from: TodoStatus,
    to: TodoStatus,
  },
) {}

export class Todo extends Schema.Class<Todo>("Todo")({
  id: TodoId,
  sessionId: SessionId,
  branchId: BranchId,
  parentId: Schema.optional(TodoId),
  subject: Schema.String,
  description: Schema.optional(Schema.String),
  status: TodoStatus,
  owner: Schema.optional(SessionId),
  agentType: Schema.optional(AgentName),
  prompt: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  createdAt: DateFromNumber,
  updatedAt: DateFromNumber,
}) {}
