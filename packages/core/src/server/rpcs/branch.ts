import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { GentRpcError } from "../errors.js"
import {
  ListBranchesInput,
  BranchInfo,
  CreateBranchInput,
  CreateBranchResult,
  BranchTreeNodeSchema,
  GetBranchTreeInput,
  SwitchBranchInput,
  ForkBranchInput,
  ForkBranchResult,
} from "../transport-contract.js"

export class BranchRpcs extends RpcGroup.make(
  Rpc.make("list", {
    payload: ListBranchesInput.fields,
    success: Schema.Array(BranchInfo),
    error: GentRpcError,
  }),
  Rpc.make("create", {
    payload: CreateBranchInput.fields,
    success: CreateBranchResult,
    error: GentRpcError,
  }),
  Rpc.make("getTree", {
    payload: GetBranchTreeInput.fields,
    success: Schema.Array(BranchTreeNodeSchema),
    error: GentRpcError,
  }),
  Rpc.make("switch", {
    payload: SwitchBranchInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("fork", {
    payload: ForkBranchInput.fields,
    success: ForkBranchResult,
    error: GentRpcError,
  }),
).prefix("branch.") {}
