import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"

export const ServerStatusResult = Schema.Struct({
  serverId: Schema.String,
  pid: Schema.Number,
  hostname: Schema.String,
  uptime: Schema.Number,
  connectionCount: Schema.Number,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
})
export type ServerStatusResult = typeof ServerStatusResult.Type

export class ServerRpcs extends RpcGroup.make(
  Rpc.make("status", {
    success: ServerStatusResult,
    error: GentRpcError,
  }),
).prefix("server.") {}
