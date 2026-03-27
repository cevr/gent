import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { Model } from "../../domain/model.js"
import { GentRpcError } from "../errors.js"

export class ModelRpcs extends RpcGroup.make(
  Rpc.make("list", {
    success: Schema.Array(Model),
    error: GentRpcError,
  }),
).prefix("model.") {}
