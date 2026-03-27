import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  DrainQueuedMessagesPayload,
  DrainQueuedMessagesSuccess,
  GetQueuedMessagesPayload,
  GetQueuedMessagesSuccess,
} from "../transport-contract.js"

export class QueueRpcs extends RpcGroup.make(
  Rpc.make("drain", {
    payload: DrainQueuedMessagesPayload.fields,
    success: DrainQueuedMessagesSuccess,
    error: GentRpcError,
  }),
  Rpc.make("get", {
    payload: GetQueuedMessagesPayload.fields,
    success: GetQueuedMessagesSuccess,
    error: GentRpcError,
  }),
).prefix("queue.") {}
