import { Schema } from "effect"
import {
  ExtensionMessage,
  Task,
  TaskStatus,
  TaskId,
  SessionId,
  BranchId,
  AgentName,
} from "@gent/core/extensions/api"

export const TASK_TOOLS_EXTENSION_ID = "@gent/task-tools"

/** Schema for individual task entries in the UI snapshot (subset of full Task). */
export const TaskEntrySchema = Schema.Struct({
  id: TaskId,
  subject: Schema.String,
  status: TaskStatus,
})
export type TaskEntry = typeof TaskEntrySchema.Type

/** Schema for the task-tools extension UI snapshot model. */
export const TaskUiModel = Schema.Struct({
  tasks: Schema.Array(TaskEntrySchema),
})
export type TaskUiModel = typeof TaskUiModel.Type

export const TaskProtocol = {
  DeleteTask: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "DeleteTask",
    {
      taskId: TaskId,
    },
    Schema.Null,
  ),
  CreateTask: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "CreateTask",
    {
      sessionId: SessionId,
      branchId: BranchId,
      subject: Schema.String,
      description: Schema.optional(Schema.String),
      agentType: Schema.optional(AgentName),
      prompt: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Unknown),
    },
    Task,
  ),
  GetTask: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "GetTask",
    {
      taskId: TaskId,
    },
    Schema.NullOr(Task),
  ),
  ListTasks: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "ListTasks",
    {
      sessionId: SessionId,
      branchId: Schema.optional(BranchId),
    },
    Schema.Array(Task),
  ),
  UpdateTask: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "UpdateTask",
    {
      taskId: TaskId,
      status: Schema.optional(
        Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]),
      ),
      description: Schema.optional(Schema.NullOr(Schema.String)),
      owner: Schema.optional(Schema.NullOr(SessionId)),
      metadata: Schema.optional(Schema.NullOr(Schema.Unknown)),
    },
    Schema.NullOr(Task),
  ),
  AddDependency: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "AddDependency",
    {
      taskId: TaskId,
      blockedById: TaskId,
    },
    Schema.Null,
  ),
  RemoveDependency: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "RemoveDependency",
    {
      taskId: TaskId,
      blockedById: TaskId,
    },
    Schema.Null,
  ),
  GetDependencies: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "GetDependencies",
    {
      taskId: TaskId,
    },
    Schema.Array(TaskId),
  ),
}
