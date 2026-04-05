import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import { RespondInteractionInput } from "../transport-contract.js"

export class InteractionRpcs extends RpcGroup.make(
  Rpc.make("respondInteraction", {
    payload: RespondInteractionInput.fields,
    error: GentRpcError,
  }),
).prefix("interaction.") {}
