import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  RespondQuestionsPayload,
  RespondPermissionPayload,
  RespondPromptPayload,
  RespondHandoffPayload,
  RespondHandoffSuccess,
} from "../transport-contract.js"

export class InteractionRpcs extends RpcGroup.make(
  Rpc.make("respondQuestions", {
    payload: RespondQuestionsPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("respondPermission", {
    payload: RespondPermissionPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("respondPrompt", {
    payload: RespondPromptPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("respondHandoff", {
    payload: RespondHandoffPayload.fields,
    success: RespondHandoffSuccess,
    error: GentRpcError,
  }),
).prefix("interaction.") {}
