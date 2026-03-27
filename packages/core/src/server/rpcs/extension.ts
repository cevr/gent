import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import { SendExtensionIntentPayload } from "../transport-contract.js"

export class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("sendIntent", {
    payload: SendExtensionIntentPayload.fields,
    error: GentRpcError,
  }),
).prefix("extension.") {}
