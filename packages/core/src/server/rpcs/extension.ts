import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { SessionId } from "../../domain/ids.js"
import { GentRpcError } from "../errors.js"
import {
  ExtensionRpcRequestInput,
  ExtensionHealthSnapshot,
  SlashCommandInfo,
} from "../transport-contract.js"

export class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("request", {
    payload: ExtensionRpcRequestInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("listStatus", {
    payload: { sessionId: Schema.optional(SessionId) },
    success: ExtensionHealthSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("listSlashCommands", {
    payload: { sessionId: SessionId },
    success: Schema.Array(SlashCommandInfo),
    error: GentRpcError,
  }),
).prefix("extension.") {}
