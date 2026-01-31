import { Effect } from "effect"
import { GentRpcs } from "./rpcs"
import { GentCore } from "./core"
import type { SteerCommand } from "@gent/runtime"
import { AskUserHandler } from "@gent/tools"
import {
  AuthGuard,
  AuthStorage,
  Permission,
  PermissionHandler,
  PermissionRule,
  PlanHandler,
} from "@gent/core"
import { ActorProcess, ConfigService, ModelRegistry } from "@gent/runtime"

// ============================================================================
// RPC Handlers Layer
// ============================================================================

export const RpcHandlersLive = GentRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* GentCore
    const askUserHandler = yield* AskUserHandler
    const permissionHandler = yield* PermissionHandler
    const planHandler = yield* PlanHandler
    const permission = yield* Permission
    const configService = yield* ConfigService
    const actorProcess = yield* ActorProcess
    const modelRegistry = yield* ModelRegistry
    const authStorage = yield* AuthStorage
    const authGuard = yield* AuthGuard

    return {
      createSession: (input) =>
        core.createSession({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.firstMessage !== undefined ? { firstMessage: input.firstMessage } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.bypass !== undefined ? { bypass: input.bypass } : {}),
        }),

      listSessions: () => core.listSessions(),

      getSession: ({ sessionId }) => core.getSession(sessionId),

      deleteSession: ({ sessionId }) => core.deleteSession(sessionId),

      listBranches: ({ sessionId }) => core.listBranches(sessionId),

      createBranch: ({ sessionId, name }) =>
        core.createBranch({
          sessionId,
          ...(name !== undefined ? { name } : {}),
        }),

      getBranchTree: ({ sessionId }) => core.getBranchTree(sessionId),

      switchBranch: ({ sessionId, fromBranchId, toBranchId, summarize }) =>
        core.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          ...(summarize !== undefined ? { summarize } : {}),
        }),

      forkBranch: ({ sessionId, fromBranchId, atMessageId, name }) =>
        core.forkBranch({
          sessionId,
          fromBranchId,
          atMessageId,
          ...(name !== undefined ? { name } : {}),
        }),

      sendMessage: ({ sessionId, branchId, content }) =>
        core.sendMessage({
          sessionId,
          branchId,
          content,
        }),

      listMessages: ({ branchId }) => core.listMessages(branchId),

      getSessionState: ({ sessionId, branchId }) => core.getSessionState({ sessionId, branchId }),

      steer: ({ command }) => core.steer(command as SteerCommand),

      subscribeEvents: ({ sessionId, branchId, after }) =>
        // Return the stream directly for streaming RPC
        core.subscribeEvents({
          sessionId,
          ...(branchId !== undefined ? { branchId } : {}),
          ...(after !== undefined ? { after } : {}),
        }),

      respondQuestions: ({ requestId, answers }) => askUserHandler.respond(requestId, answers),

      respondPermission: ({ requestId, decision, persist }) =>
        Effect.gen(function* () {
          const request = yield* permissionHandler.respond(requestId, decision)
          if (persist === true && request !== undefined) {
            const rule = new PermissionRule({
              tool: request.toolName,
              action: decision,
            })
            yield* configService.addPermissionRule(rule)
            yield* permission.addRule(rule)
          }
        }),

      respondPlan: ({ requestId, decision, reason }) =>
        Effect.gen(function* () {
          const entry = yield* planHandler.respond(requestId, decision, reason)
          if (decision !== "confirm" || entry?.planPath === undefined) return
          yield* core.approvePlan({
            sessionId: entry.sessionId,
            branchId: entry.branchId,
            planPath: entry.planPath,
            requestId,
            emitEvent: false,
          })
        }),

      compactBranch: ({ sessionId, branchId }) => core.compactBranch({ sessionId, branchId }),

      updateSessionBypass: ({ sessionId, bypass }) =>
        core.updateSessionBypass({ sessionId, bypass }),

      getPermissionRules: () => configService.getPermissionRules(),

      deletePermissionRule: ({ tool, pattern }) =>
        Effect.gen(function* () {
          yield* configService.removePermissionRule(tool, pattern)
          yield* permission.removeRule(tool, pattern)
        }),

      listModels: () => modelRegistry.list(),

      listAuthProviders: () => authGuard.listProviders(),

      setAuthKey: ({ provider, key }) =>
        authStorage.set(provider, key).pipe(Effect.catchAll(() => Effect.void)),

      deleteAuthKey: ({ provider }) =>
        authStorage.delete(provider).pipe(Effect.catchAll(() => Effect.void)),

      actorSendUserMessage: (input) => actorProcess.sendUserMessage(input),

      actorSendToolResult: (input) => actorProcess.sendToolResult(input),

      actorInterrupt: (input) => actorProcess.interrupt(input),

      actorGetState: ({ sessionId, branchId }) => actorProcess.getState({ sessionId, branchId }),

      actorGetMetrics: ({ sessionId, branchId }) =>
        actorProcess.getMetrics({ sessionId, branchId }),
    }
  }),
)
