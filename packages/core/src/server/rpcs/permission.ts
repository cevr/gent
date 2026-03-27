import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { PermissionRule } from "../../domain/permission.js"
import { GentRpcError } from "../errors.js"
import { DeletePermissionRuleInput } from "../transport-contract.js"

export class PermissionRpcs extends RpcGroup.make(
  Rpc.make("listRules", {
    success: Schema.Array(PermissionRule),
    error: GentRpcError,
  }),
  Rpc.make("deleteRule", {
    payload: DeletePermissionRuleInput.fields,
    error: GentRpcError,
  }),
).prefix("permission.") {}
