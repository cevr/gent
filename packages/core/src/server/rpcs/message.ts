import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { Message } from "../../domain/message.js"
import { GentRpcError } from "../errors.js"
import { SendMessageInput, ListMessagesInput } from "../transport-contract.js"

export class MessageRpcs extends RpcGroup.make(
  Rpc.make("send", {
    payload: SendMessageInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("list", {
    payload: ListMessagesInput.fields,
    success: Schema.Array(Message),
    error: GentRpcError,
  }),
).prefix("message.") {}
