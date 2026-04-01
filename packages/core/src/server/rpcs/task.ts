import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SessionId, BranchId, TaskId } from "../../domain/ids.js"
import { Task, TaskStatus } from "../../domain/task.js"
import { GentRpcError } from "../errors.js"

export const MessageSummary = Schema.Struct({
  role: Schema.String,
  excerpt: Schema.String,
})
export type MessageSummary = typeof MessageSummary.Type

export class TaskRpcs extends RpcGroup.make(
  Rpc.make("list", {
    payload: {
      sessionId: SessionId,
      branchId: Schema.optional(BranchId),
    },
    success: Schema.Array(Task),
    error: GentRpcError,
  }),
  Rpc.make("stop", {
    payload: { taskId: TaskId },
    success: Schema.Struct({
      task: Schema.optional(Task),
    }),
    error: GentRpcError,
  }),
  Rpc.make("output", {
    payload: { taskId: TaskId },
    success: Schema.Struct({
      status: TaskStatus,
      messageCount: Schema.Number,
      messages: Schema.optional(Schema.Array(MessageSummary)),
    }),
    error: GentRpcError,
  }),
).prefix("task.") {}
