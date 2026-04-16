import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  AskExtensionMessageInput,
  CommandInfo,
  ExtensionHealthSnapshot,
  InvokeCommandInput,
  ListExtensionStatusInput,
  MutateExtensionInput,
  QueryExtensionInput,
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
  Rpc.make("query", {
    payload: QueryExtensionInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("mutate", {
    payload: MutateExtensionInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("listStatus", {
    payload: ListExtensionStatusInput.fields,
    success: ExtensionHealthSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("listCommands", {
    success: Schema.Array(CommandInfo),
    error: GentRpcError,
  }),
  Rpc.make("invokeCommand", {
    payload: InvokeCommandInput.fields,
    error: GentRpcError,
  }),
).prefix("extension.") {}
