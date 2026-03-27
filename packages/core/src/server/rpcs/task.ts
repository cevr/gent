import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SessionId, BranchId } from "../../domain/ids.js"
import { Task } from "../../domain/task.js"
import { GentRpcError } from "../errors.js"

export class TaskRpcs extends RpcGroup.make(
  Rpc.make("list", {
    payload: {
      sessionId: SessionId,
      branchId: Schema.optional(BranchId),
    },
    success: Schema.Array(Task),
    error: GentRpcError,
  }),
).prefix("task.") {}
