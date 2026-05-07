import { Schema } from "effect"
import { AgentName, BranchId, DateFromNumber, SessionId } from "@gent/core/extensions/api"

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const TaskStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "stopped",
])
export type TaskStatus = typeof TaskStatus.Type

const VALID_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
  ["pending", new Set<TaskStatus>(["in_progress", "failed", "stopped"])],
  ["in_progress", new Set<TaskStatus>(["completed", "failed", "stopped"])],
  ["completed", new Set<TaskStatus>()],
  ["failed", new Set<TaskStatus>()],
  ["stopped", new Set<TaskStatus>()],
])

export const isValidTaskTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  VALID_TRANSITIONS.get(from)?.has(to) === true

export class TaskTransitionError extends Schema.TaggedErrorClass<TaskTransitionError>()(
  "TaskTransitionError",
  {
    message: Schema.String,
    from: TaskStatus,
    to: TaskStatus,
  },
) {}

export class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  sessionId: SessionId,
  branchId: BranchId,
  subject: Schema.String,
  description: Schema.optional(Schema.String),
  status: TaskStatus,
  owner: Schema.optional(SessionId),
  agentType: Schema.optional(AgentName),
  prompt: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  createdAt: DateFromNumber,
  updatedAt: DateFromNumber,
}) {}
