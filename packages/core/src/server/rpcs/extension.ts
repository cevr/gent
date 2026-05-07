import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { SessionId } from "../../domain/ids.js"
import { Model } from "../../domain/model.js"
import { PermissionRule } from "../../domain/permission.js"
import { GentRpcError } from "../errors.js"
import {
  ClearDriverOverrideInput,
  DeletePermissionRuleInput,
  DriverListResult,
  ExtensionRpcRequestInput,
  ExtensionHealthSnapshot,
  SetDriverOverrideInput,
  SlashCommandInfo,
} from "../transport-contract.js"

export class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("extension.request", {
    payload: ExtensionRpcRequestInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("extension.listStatus", {
    payload: { sessionId: Schema.optional(SessionId) },
    success: ExtensionHealthSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("extension.listSlashCommands", {
    payload: { sessionId: SessionId },
    success: Schema.Array(SlashCommandInfo),
    error: GentRpcError,
  }),
  Rpc.make("driver.list", {
    success: DriverListResult,
    error: GentRpcError,
  }),
  Rpc.make("driver.set", {
    payload: SetDriverOverrideInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("driver.clear", {
    payload: ClearDriverOverrideInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("model.list", {
    success: Schema.Array(Model),
    error: GentRpcError,
  }),
  Rpc.make("permission.listRules", {
    success: Schema.Array(PermissionRule),
    error: GentRpcError,
  }),
  Rpc.make("permission.deleteRule", {
    payload: DeletePermissionRuleInput.fields,
    error: GentRpcError,
  }),
) {}
