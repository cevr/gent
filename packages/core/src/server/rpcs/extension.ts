import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  ExtensionRpcRequestInput,
  ExtensionHealthSnapshot,
  ListExtensionSlashCommandsInput,
  ListExtensionStatusInput,
  SlashCommandInfo,
} from "../transport-contract.js"

export class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("request", {
    payload: ExtensionRpcRequestInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("listStatus", {
    payload: ListExtensionStatusInput.fields,
    success: ExtensionHealthSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("listSlashCommands", {
    payload: ListExtensionSlashCommandsInput.fields,
    success: Schema.Array(SlashCommandInfo),
    error: GentRpcError,
  }),
).prefix("extension.") {}
