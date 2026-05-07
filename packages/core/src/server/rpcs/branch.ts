import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { Branch, BranchTreeNode } from "../../domain/message.js"
import { BranchId, SessionId } from "../../domain/ids.js"
import { GentRpcError } from "../errors.js"
import { CreateBranchInput, SwitchBranchInput, ForkBranchInput } from "../transport-contract.js"

export class BranchRpcs extends RpcGroup.make(
  Rpc.make("list", {
    payload: { sessionId: SessionId },
    success: Schema.Array(Branch),
    error: GentRpcError,
  }),
  Rpc.make("create", {
    payload: CreateBranchInput.fields,
    success: Schema.Struct({ branchId: BranchId }),
    error: GentRpcError,
  }),
  Rpc.make("getTree", {
    payload: { sessionId: SessionId },
    success: Schema.Array(BranchTreeNode),
    error: GentRpcError,
  }),
  Rpc.make("switch", {
    payload: SwitchBranchInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("fork", {
    payload: ForkBranchInput.fields,
    success: Schema.Struct({ branchId: BranchId }),
    error: GentRpcError,
  }),
).prefix("branch.") {}
