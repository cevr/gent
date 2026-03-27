import { Rpc, RpcGroup } from "effect/unstable/rpc"
import {
  ActorProcessMetrics,
  ActorProcessState,
  ActorTarget,
  InterruptPayload,
  InvokeToolPayload,
  SendToolResultPayload,
  SendUserMessagePayload,
} from "../../runtime/actor-process.js"
import { GentRpcError } from "../errors.js"

export class ActorRpcs extends RpcGroup.make(
  Rpc.make("sendUserMessage", {
    payload: SendUserMessagePayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("sendToolResult", {
    payload: SendToolResultPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("invokeTool", {
    payload: InvokeToolPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("interrupt", {
    payload: InterruptPayload.fields,
    error: GentRpcError,
  }),
  Rpc.make("getState", {
    payload: ActorTarget.fields,
    success: ActorProcessState,
    error: GentRpcError,
  }),
  Rpc.make("getMetrics", {
    payload: ActorTarget.fields,
    success: ActorProcessMetrics,
    error: GentRpcError,
  }),
).prefix("actor.") {}
