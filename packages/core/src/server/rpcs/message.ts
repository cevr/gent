import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { Message } from "../../domain/message.js"
import { BranchId } from "../../domain/ids.js"
import { GentRpcError } from "../errors.js"
import { SendMessageInput } from "../transport-contract.js"

export class MessageRpcs extends RpcGroup.make(
  Rpc.make("send", {
    payload: SendMessageInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("list", {
    payload: { branchId: BranchId },
    success: Schema.Array(Message),
    error: GentRpcError,
  }),
).prefix("message.") {}
