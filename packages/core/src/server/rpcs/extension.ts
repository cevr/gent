import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import { SendExtensionIntentInput } from "../transport-contract.js"

export class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("sendIntent", {
    payload: SendExtensionIntentInput.fields,
    error: GentRpcError,
  }),
).prefix("extension.") {}
