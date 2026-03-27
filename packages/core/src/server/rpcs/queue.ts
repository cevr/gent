import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import { QueueTarget, QueueSnapshot } from "../transport-contract.js"

export class QueueRpcs extends RpcGroup.make(
  Rpc.make("drain", {
    payload: QueueTarget.fields,
    success: QueueSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("get", {
    payload: QueueTarget.fields,
    success: QueueSnapshot,
    error: GentRpcError,
  }),
).prefix("queue.") {}
