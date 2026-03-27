import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import { SteerCommand } from "../transport-contract.js"

export class SteerRpcs extends RpcGroup.make(
  Rpc.make("command", {
    payload: { command: SteerCommand },
    error: GentRpcError,
  }),
).prefix("steer.") {}
