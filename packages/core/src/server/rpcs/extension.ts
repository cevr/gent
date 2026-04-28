import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  CommandInfo,
  ExtensionHealthSnapshot,
  ListExtensionCommandsInput,
  RequestCapabilityInput,
  ListExtensionStatusInput,
} from "../transport-contract.js"

export class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("request", {
    payload: RequestCapabilityInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("listStatus", {
    payload: ListExtensionStatusInput.fields,
    success: ExtensionHealthSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("listCommands", {
    payload: ListExtensionCommandsInput.fields,
    success: Schema.Array(CommandInfo),
    error: GentRpcError,
  }),
).prefix("extension.") {}
