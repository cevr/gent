import { Effect } from "effect"
import { GentRpcs } from "@gent/api"
import { GentCore } from "./core.js"
import type { SteerCommand } from "@gent/runtime"

// ============================================================================
// RPC Handlers Layer
// ============================================================================

export const RpcHandlersLive = GentRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* GentCore

    return {
      createSession: (input) =>
        core
          .createSession(input.name !== undefined ? { name: input.name } : {})
          .pipe(Effect.orDie),

      listSessions: () => core.listSessions().pipe(Effect.orDie),

      getSession: ({ sessionId }) =>
        core.getSession(sessionId).pipe(Effect.orDie),

      deleteSession: ({ sessionId }) =>
        core.deleteSession(sessionId).pipe(Effect.orDie),

      sendMessage: ({ sessionId, branchId, content }) =>
        core.sendMessage({ sessionId, branchId, content }).pipe(Effect.orDie),

      listMessages: ({ branchId }) =>
        core.listMessages(branchId).pipe(Effect.orDie),

      steer: ({ command }) =>
        core.steer(command as SteerCommand).pipe(Effect.orDie),

      subscribeEvents: ({ sessionId }) =>
        // Return the stream directly for streaming RPC
        core.subscribeEvents(sessionId),
    }
  })
)
