import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { TaskId } from "../../domain/ids.js"
import { TaskStatus } from "../../domain/task.js"
import { GentRpcError } from "../errors.js"

export const MessageSummary = Schema.Struct({
  role: Schema.String,
  excerpt: Schema.String,
})
export type MessageSummary = typeof MessageSummary.Type

export class TaskRpcs extends RpcGroup.make(
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
