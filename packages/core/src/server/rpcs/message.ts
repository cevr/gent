import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { GentRpcError } from "../errors.js"
import { SendMessagePayload, ListMessagesPayload, MessageInfo } from "../transport-contract.js"

export class MessageRpcs extends RpcGroup.make(
  Rpc.make("send", {
    payload: SendMessagePayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("list", {
    payload: ListMessagesPayload.fields,
    success: Schema.Array(MessageInfo),
    error: GentRpcError,
  }),
).prefix("message.") {}
