import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import { SteerPayload } from "../transport-contract.js"

export class SteerRpcs extends RpcGroup.make(
  Rpc.make("command", {
    payload: { command: SteerPayload },
    error: GentRpcError,
  }),
).prefix("steer.") {}
