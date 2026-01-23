import { Effect } from "effect"
import { GentRpcs } from "./rpcs"
import { GentCore } from "./core"
import type { SteerCommand } from "@gent/runtime"
import { AskUserHandler } from "@gent/tools"
import { Permission, PermissionHandler, PermissionRule, PlanHandler, AuthStorage } from "@gent/core"
import { ConfigService } from "@gent/runtime"
import type { AuthProviderInfo } from "./operations"

// Known providers for auth listing
const KNOWN_PROVIDERS = ["anthropic", "openai", "bedrock"] as const
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
}

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
    const authStorage = yield* AuthStorage

    return {
      createSession: (input) =>
        core
          .createSession({
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
        core
          .createBranch({
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

      respondPermission: ({ requestId, decision, persist }) =>
        Effect.gen(function* () {
          const request = yield* permissionHandler.respond(requestId, decision)
          if (persist && request) {
            const rule = new PermissionRule({
              tool: request.toolName,
              action: decision,
            })
            yield* configService.addPermissionRule(rule)
            yield* permission.addRule(rule)
          }
        }),

      respondPlan: ({ requestId, decision, reason }) =>
        planHandler.respond(requestId, decision, reason),

      compactBranch: ({ sessionId, branchId }) =>
        core.compactBranch({ sessionId, branchId }),

      updateSessionBypass: ({ sessionId, bypass }) =>
        core.updateSessionBypass({ sessionId, bypass }),

      getPermissionRules: () => configService.getPermissionRules(),

      deletePermissionRule: ({ tool, pattern }) =>
        Effect.gen(function* () {
          yield* configService.removePermissionRule(tool, pattern)
          yield* permission.removeRule(tool, pattern)
        }),

      listAuthProviders: () =>
        Effect.gen(function* () {
          const storedKeys = yield* authStorage.list().pipe(
            Effect.catchAll(() => Effect.succeed([] as readonly string[])),
          )
          const storedSet = new Set(storedKeys)

          const providers: AuthProviderInfo[] = KNOWN_PROVIDERS.map((provider) => {
            const envVar = PROVIDER_ENV_VARS[provider]
            const hasEnv = envVar ? !!process.env[envVar] : false
            const hasStored = storedSet.has(provider)

            if (hasEnv) {
              return { provider, hasKey: true, source: "env" as const }
            }
            if (hasStored) {
              return { provider, hasKey: true, source: "stored" as const }
            }
            return { provider, hasKey: false }
          })

          return providers
        }),

      setAuthKey: ({ provider, key }) =>
        authStorage.set(provider, key).pipe(
          Effect.catchAll(() => Effect.void),
        ),

      deleteAuthKey: ({ provider }) =>
        authStorage.delete(provider).pipe(
          Effect.catchAll(() => Effect.void),
        ),
    }
  }),
)
