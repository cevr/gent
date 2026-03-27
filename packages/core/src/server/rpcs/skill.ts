import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { GentRpcError } from "../errors.js"
import { SkillContent } from "../transport-contract.js"

export class SkillRpcs extends RpcGroup.make(
  Rpc.make("list", {
    success: Schema.Array(SkillContent),
    error: GentRpcError,
  }),
  Rpc.make("getContent", {
    payload: { name: Schema.String },
    success: Schema.NullOr(SkillContent),
    error: GentRpcError,
  }),
).prefix("skill.") {}
