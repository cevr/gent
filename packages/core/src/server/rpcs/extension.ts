import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  AskExtensionMessageInput,
  ExtensionStatusInfo,
  ListExtensionStatusInput,
  SendExtensionMessageInput,
} from "../transport-contract.js"

export class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("send", {
    payload: SendExtensionMessageInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("ask", {
    payload: AskExtensionMessageInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("listStatus", {
    payload: ListExtensionStatusInput.fields,
    success: Schema.Array(ExtensionStatusInfo),
    error: GentRpcError,
  }),
).prefix("extension.") {}
