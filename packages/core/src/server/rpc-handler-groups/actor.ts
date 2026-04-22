import type {
  InterruptPayload,
  InvokeToolPayload,
  SendToolResultPayload,
  SendUserMessagePayload,
  SessionRuntimeTarget,
} from "../../runtime/session-runtime.js"
import {
  applySteerCommand,
  interruptPayloadToSteerCommand,
  invokeToolCommand,
  recordToolResultCommand,
  sendUserMessageCommand,
} from "../../runtime/session-runtime.js"
import type { RpcHandlerDeps } from "./shared.js"

export const buildActorRpcHandlers = (deps: RpcHandlerDeps) => ({
  "actor.sendUserMessage": (input: SendUserMessagePayload) =>
    deps.sessionRuntime.dispatch(sendUserMessageCommand(input)),

  "actor.sendToolResult": (input: SendToolResultPayload) =>
    deps.sessionRuntime.dispatch(recordToolResultCommand(input)),

  "actor.invokeTool": (input: InvokeToolPayload) =>
    deps.sessionRuntime.dispatch(invokeToolCommand(input)),

  "actor.interrupt": (input: InterruptPayload) =>
    deps.sessionRuntime.dispatch(applySteerCommand(interruptPayloadToSteerCommand(input))),

  "actor.getState": ({ sessionId, branchId }: SessionRuntimeTarget) =>
    deps.sessionRuntime.getState({ sessionId, branchId }),

  "actor.getMetrics": ({ sessionId, branchId }: SessionRuntimeTarget) =>
    deps.sessionRuntime.getMetrics({ sessionId, branchId }),
})
