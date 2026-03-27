import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { GentRpcError } from "../errors.js"
import { SendMessageInput, ListMessagesInput, MessageInfo } from "../transport-contract.js"

export class MessageRpcs extends RpcGroup.make(
  Rpc.make("send", {
    payload: SendMessageInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("list", {
    payload: ListMessagesInput.fields,
    success: Schema.Array(MessageInfo),
    error: GentRpcError,
  }),
).prefix("message.") {}
