import type {
  InterruptPayload,
  InvokeToolPayload,
  SendToolResultPayload,
  SendUserMessagePayload,
  SessionRuntimeTarget,
} from "../../runtime/session-runtime.js"
import type { RpcHandlerDeps } from "./shared.js"

export const buildActorRpcHandlers = (deps: RpcHandlerDeps) => ({
  "actor.sendUserMessage": (input: SendUserMessagePayload) =>
    deps.sessionRuntime.sendUserMessage(input),

  "actor.sendToolResult": (input: SendToolResultPayload) =>
    deps.sessionRuntime.sendToolResult(input),

  "actor.invokeTool": (input: InvokeToolPayload) => deps.sessionRuntime.invokeTool(input),

  "actor.interrupt": (input: InterruptPayload) => deps.sessionRuntime.interrupt(input),

  "actor.getState": ({ sessionId, branchId }: SessionRuntimeTarget) =>
    deps.sessionRuntime.getState({ sessionId, branchId }),

  "actor.getMetrics": ({ sessionId, branchId }: SessionRuntimeTarget) =>
    deps.sessionRuntime.getMetrics({ sessionId, branchId }),
})
