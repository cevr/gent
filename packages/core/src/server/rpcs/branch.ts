import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { GentRpcError } from "../errors.js"
import {
  ListBranchesPayload,
  BranchInfo,
  CreateBranchPayload,
  CreateBranchSuccess,
  BranchTreeNodeSchema,
  GetBranchTreePayload,
  SwitchBranchPayload,
  ForkBranchPayload,
  ForkBranchSuccess,
} from "../transport-contract.js"

export class BranchRpcs extends RpcGroup.make(
  Rpc.make("list", {
    payload: ListBranchesPayload.fields,
    success: Schema.Array(BranchInfo),
    error: GentRpcError,
  }),
  Rpc.make("create", {
    payload: CreateBranchPayload.fields,
    success: CreateBranchSuccess,
    error: GentRpcError,
  }),
  Rpc.make("getTree", {
    payload: GetBranchTreePayload.fields,
    success: Schema.Array(BranchTreeNodeSchema),
    error: GentRpcError,
  }),
  Rpc.make("switch", {
    payload: SwitchBranchPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("fork", {
    payload: ForkBranchPayload.fields,
    success: ForkBranchSuccess,
    error: GentRpcError,
  }),
).prefix("branch.") {}
