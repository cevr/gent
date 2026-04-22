import { Rpc, RpcGroup } from "effect/unstable/rpc"
import {
  InterruptPayload,
  InvokeToolPayload,
  SendToolResultPayload,
  SendUserMessagePayload,
  SessionRuntimeMetrics,
  SessionRuntimeStateSchema,
  SessionRuntimeTarget,
} from "../../runtime/session-runtime.js"
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
    payload: SessionRuntimeTarget.fields,
    success: SessionRuntimeStateSchema,
    error: GentRpcError,
  }),
  Rpc.make("getMetrics", {
    payload: SessionRuntimeTarget.fields,
    success: SessionRuntimeMetrics,
    error: GentRpcError,
  }),
).prefix("actor.") {}
