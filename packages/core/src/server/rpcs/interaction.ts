import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { GentRpcError } from "../errors.js"
import {
  RespondQuestionsInput,
  RespondPromptInput,
  RespondHandoffInput,
  RespondHandoffResult,
} from "../transport-contract.js"

export class InteractionRpcs extends RpcGroup.make(
  Rpc.make("respondQuestions", {
    payload: RespondQuestionsInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("respondPrompt", {
    payload: RespondPromptInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("respondHandoff", {
    payload: RespondHandoffInput.fields,
    success: RespondHandoffResult,
    error: GentRpcError,
  }),
).prefix("interaction.") {}
