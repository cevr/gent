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
          })
          .pipe(Effect.orDie),

      listSessions: () => core.listSessions().pipe(Effect.orDie),

      getSession: ({ sessionId }) => core.getSession(sessionId).pipe(Effect.orDie),

      deleteSession: ({ sessionId }) => core.deleteSession(sessionId).pipe(Effect.orDie),

      listBranches: ({ sessionId }) => core.listBranches(sessionId).pipe(Effect.orDie),

      createBranch: ({ sessionId, name }) =>
        core
          .createBranch({
            sessionId,
            ...(name !== undefined ? { name } : {}),
          })
          .pipe(Effect.orDie),

      sendMessage: ({ sessionId, branchId, content, mode, model }) =>
        core
          .sendMessage({
            sessionId,
            branchId,
            content,
            ...(mode !== undefined ? { mode } : {}),
            ...(model !== undefined ? { model } : {}),
          })
          .pipe(Effect.orDie),

      listMessages: ({ branchId }) => core.listMessages(branchId).pipe(Effect.orDie),

      steer: ({ command }) => core.steer(command as SteerCommand).pipe(Effect.orDie),

      subscribeEvents: ({ sessionId }) =>
        // Return the stream directly for streaming RPC
        core.subscribeEvents(sessionId),

      respondQuestions: ({ requestId, answers }) =>
        askUserHandler.respond(requestId, answers).pipe(Effect.orDie),

      respondPermission: ({ requestId, decision }) =>
        permissionHandler.respond(requestId, decision).pipe(Effect.orDie),

      respondPlan: ({ requestId, decision, reason }) =>
        planHandler.respond(requestId, decision, reason).pipe(Effect.orDie),
    }
  }),
)
