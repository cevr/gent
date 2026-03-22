import { Schema } from "effect"
import { SessionId, BranchId, TaskId } from "./ids"
import { AgentName } from "./agent"
import { DateFromNumber } from "./message"

// Task Status

export const TaskStatus = Schema.Literals(["pending", "in_progress", "completed", "failed"])
export type TaskStatus = typeof TaskStatus.Type

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
