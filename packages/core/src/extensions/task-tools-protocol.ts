import { Schema } from "effect"
import { ExtensionMessage } from "../domain/extension-protocol.js"
import { Task } from "../domain/task.js"
import { TaskId, SessionId, BranchId } from "../domain/ids.js"
import { AgentName } from "../domain/agent.js"

export const TASK_TOOLS_EXTENSION_ID = "@gent/task-tools"

export const TaskOutputSummary = Schema.Struct({
  status: Schema.Literals(["pending", "in_progress", "completed", "failed", "stopped"]),
  messageCount: Schema.Number,
  messages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        role: Schema.String,
        excerpt: Schema.String,
      }),
    ),
  ),
})

export const TaskProtocol = {
  StopTask: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "StopTask",
    {
      taskId: TaskId,
    },
    Schema.NullOr(Task),
  ),
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
  RunTask: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "RunTask",
    {
      taskId: TaskId,
    },
    Schema.Struct({
      taskId: TaskId,
      status: Schema.String,
      sessionId: Schema.optional(SessionId),
      branchId: Schema.optional(BranchId),
    }),
  ),
  GetTaskOutput: ExtensionMessage.reply(
    TASK_TOOLS_EXTENSION_ID,
    "GetTaskOutput",
    {
      taskId: TaskId,
    },
    Schema.NullOr(TaskOutputSummary),
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
