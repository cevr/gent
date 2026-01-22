import { Effect } from "effect"
import { GentRpcs } from "./rpcs"
import { GentCore } from "./core"
import type { SteerCommand } from "@gent/runtime"
import { AskUserHandler } from "@gent/tools"
import { PermissionHandler, PlanHandler } from "@gent/core"

// ============================================================================
// RPC Handlers Layer
// ============================================================================

export const RpcHandlersLive = GentRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* GentCore
    const askUserHandler = yield* AskUserHandler
    const permissionHandler = yield* PermissionHandler
    const planHandler = yield* PlanHandler

    return {
      createSession: (input) =>
        core
          .createSession({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.firstMessage !== undefined ? { firstMessage: input.firstMessage } : {}),
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          }),

      listSessions: () => core.listSessions(),

      getSession: ({ sessionId }) => core.getSession(sessionId),

      deleteSession: ({ sessionId }) => core.deleteSession(sessionId),

      listBranches: ({ sessionId }) => core.listBranches(sessionId),

      createBranch: ({ sessionId, name }) =>
        core
          .createBranch({
            sessionId,
            ...(name !== undefined ? { name } : {}),
          }),

      sendMessage: ({ sessionId, branchId, content, mode, model }) =>
        core
          .sendMessage({
            sessionId,
            branchId,
            content,
            ...(mode !== undefined ? { mode } : {}),
            ...(model !== undefined ? { model } : {}),
          }),

      listMessages: ({ branchId }) => core.listMessages(branchId),

      getSessionState: ({ sessionId, branchId }) =>
        core.getSessionState({ sessionId, branchId }),

      steer: ({ command }) => core.steer(command as SteerCommand),

      subscribeEvents: ({ sessionId, branchId, after }) =>
        // Return the stream directly for streaming RPC
        core.subscribeEvents({
          sessionId,
          ...(branchId !== undefined ? { branchId } : {}),
          ...(after !== undefined ? { after } : {}),
        }),

      respondQuestions: ({ requestId, answers }) =>
        askUserHandler.respond(requestId, answers),

      respondPermission: ({ requestId, decision }) =>
        permissionHandler.respond(requestId, decision),

      respondPlan: ({ requestId, decision, reason }) =>
        planHandler.respond(requestId, decision, reason),
    }
  }),
)
