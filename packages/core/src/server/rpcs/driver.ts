import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  ClearDriverOverrideInput,
  DriverListResult,
  SetDriverOverrideInput,
} from "../transport-contract.js"

export class DriverRpcs extends RpcGroup.make(
  Rpc.make("list", {
    success: DriverListResult,
    error: GentRpcError,
  }),
  Rpc.make("set", {
    payload: SetDriverOverrideInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("clear", {
    payload: ClearDriverOverrideInput.fields,
    error: GentRpcError,
  }),
).prefix("driver.") {}
