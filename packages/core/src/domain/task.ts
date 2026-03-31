import { Schema } from "effect"
import { SessionId, BranchId, TaskId } from "./ids"
import { AgentName } from "./agent"
import { DateFromNumber } from "./message"

// Task Status

export const TaskStatus = Schema.Literals([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "stopped",
])
export type TaskStatus = typeof TaskStatus.Type

/** Legal task status transitions */
const VALID_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
  ["pending", new Set<TaskStatus>(["in_progress", "failed", "stopped"])],
  ["in_progress", new Set<TaskStatus>(["completed", "failed", "stopped"])],
  ["completed", new Set<TaskStatus>()],
  ["failed", new Set<TaskStatus>()],
  ["stopped", new Set<TaskStatus>()],
])

/** Returns true if the transition from → to is legal */
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

// Task

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
