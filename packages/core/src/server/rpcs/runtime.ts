import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"

export const RuntimeStatusResult = Schema.Struct({
  serverId: Schema.String,
  pid: Schema.Number,
  hostname: Schema.String,
  uptime: Schema.Number,
  connectionCount: Schema.Number,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
})
export type RuntimeStatusResult = typeof RuntimeStatusResult.Type

export class RuntimeRpcs extends RpcGroup.make(
  Rpc.make("runtime.status", {
    success: RuntimeStatusResult,
    error: GentRpcError,
  }),
) {}
