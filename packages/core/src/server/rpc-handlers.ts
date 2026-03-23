import { Effect } from "effect"
import { GentRpcs } from "./rpcs"
import { GentCore } from "./core"
import type { SteerCommand } from "../runtime/agent/agent-loop.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthApi, AuthStore } from "../domain/auth-store.js"
import { Model, type ProviderId } from "../domain/model.js"
import { Permission } from "../domain/permission.js"
import { Skills } from "../domain/skills.js"
import { ActorProcess } from "../runtime/actor-process.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { OPENAI_OAUTH_ALLOWED_MODELS } from "../providers/oauth/openai-oauth.js"

// ============================================================================
// RPC Handlers Layer
// ============================================================================

export const RpcHandlersLive = GentRpcs.toLayer(
  Effect.gen(function* () {
    const core = yield* GentCore
    const skills = yield* Skills
    const askUserHandler = yield* AskUserHandler
    const permission = yield* Permission
    const configService = yield* ConfigService
    const actorProcess = yield* ActorProcess
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth

    return {
      createSession: (input) =>
        core.createSession({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.firstMessage !== undefined ? { firstMessage: input.firstMessage } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.bypass !== undefined ? { bypass: input.bypass } : {}),
          ...(input.parentSessionId !== undefined
            ? { parentSessionId: input.parentSessionId }
            : {}),
          ...(input.parentBranchId !== undefined ? { parentBranchId: input.parentBranchId } : {}),
        }),

      listSessions: () => core.listSessions(),

      getSession: ({ sessionId }) => core.getSession(sessionId),

      deleteSession: ({ sessionId }) => core.deleteSession(sessionId),

      getChildSessions: ({ parentSessionId }) => core.getChildSessions(parentSessionId),

      getSessionTree: ({ sessionId }) =>
        core.getSessionTree(sessionId).pipe(
          Effect.map(function toRpc(node): {
            id: typeof node.session.id
            name: typeof node.session.name
            cwd: typeof node.session.cwd
            bypass: typeof node.session.bypass
            parentSessionId: typeof node.session.parentSessionId
            parentBranchId: typeof node.session.parentBranchId
            createdAt: number
            updatedAt: number
            children: ReadonlyArray<ReturnType<typeof toRpc>>
          } {
            return {
              id: node.session.id,
              name: node.session.name,
              cwd: node.session.cwd,
              bypass: node.session.bypass,
              parentSessionId: node.session.parentSessionId,
              parentBranchId: node.session.parentBranchId,
              createdAt: node.session.createdAt.getTime(),
              updatedAt: node.session.updatedAt.getTime(),
              children: node.children.map(toRpc),
            }
          }),
        ),

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

      // SAFETY: SteerPayload and SteerCommand are structurally identical Schema.Union types
      steer: ({ command }) => core.steer(command as SteerCommand),

      drainQueuedMessages: ({ sessionId, branchId }) =>
        core.drainQueuedMessages({ sessionId, branchId }),

      getQueuedMessages: ({ sessionId, branchId }) =>
        core.getQueuedMessages({ sessionId, branchId }),

      subscribeEvents: ({ sessionId, branchId, after }) =>
        // Return the stream directly for streaming RPC
        core.subscribeEvents({
          sessionId,
          ...(branchId !== undefined ? { branchId } : {}),
          ...(after !== undefined ? { after } : {}),
        }),

      respondQuestions: ({ requestId, answers }) => askUserHandler.respond(requestId, answers),

      respondPermission: ({ requestId, decision, persist }) =>
        core.respondPermission({ requestId, decision, persist }),

      respondPrompt: ({ requestId, decision, content }) =>
        core.respondPrompt({
          requestId,
          decision,
          ...(content !== undefined ? { content } : {}),
        }),

      respondHandoff: ({ requestId, decision, reason }) =>
        core.respondHandoff({
          requestId,
          decision,
          ...(reason !== undefined ? { reason } : {}),
        }),

      updateSessionBypass: ({ sessionId, bypass }) =>
        core.updateSessionBypass({ sessionId, bypass }),

      updateSessionReasoningLevel: ({ sessionId, reasoningLevel }) =>
        core.updateSessionReasoningLevel({ sessionId, reasoningLevel }),

      getPermissionRules: () => configService.getPermissionRules(),

      deletePermissionRule: ({ tool, pattern }) =>
        Effect.gen(function* () {
          yield* configService.removePermissionRule(tool, pattern)
          yield* permission.removeRule(tool, pattern)
        }),

      listModels: () =>
        Effect.gen(function* () {
          const models = yield* modelRegistry.list()
          const authInfo = yield* authStore
            .get("openai")
            .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
          if (authInfo?.type !== "oauth") return models

          return models
            .filter((model) => {
              if (model.provider !== "openai") return true
              const [, modelName] = String(model.id).split("/", 2)
              return modelName !== undefined && OPENAI_OAUTH_ALLOWED_MODELS.has(modelName)
            })
            .map((model) => {
              if (model.provider !== "openai") return model
              return new Model({
                id: model.id,
                name: model.name,
                provider: model.provider,
                ...(model.contextLength !== undefined
                  ? { contextLength: model.contextLength }
                  : {}),
                pricing: { input: 0, output: 0 },
              })
            })
        }),

      listAuthProviders: () => authGuard.listProviders(),

      setAuthKey: ({ provider, key }) =>
        authStore
          .set(provider, new AuthApi({ type: "api", key }))
          .pipe(Effect.catchEager((e) => Effect.logWarning("failed to set auth key", e))),

      deleteAuthKey: ({ provider }) =>
        authStore
          .remove(provider)
          .pipe(Effect.catchEager((e) => Effect.logWarning("failed to delete auth key", e))),

      listAuthMethods: () => providerAuth.listMethods(),

      // SAFETY: provider is validated as ProviderId by the RPC schema layer
      authorizeAuth: ({ sessionId, provider, method }) =>
        providerAuth
          .authorize(sessionId, provider as ProviderId, method)
          .pipe(Effect.map((result) => result ?? null)),

      // SAFETY: provider is validated as ProviderId by the RPC schema layer
      callbackAuth: ({ sessionId, provider, method, authorizationId, code }) =>
        providerAuth.callback(sessionId, provider as ProviderId, method, authorizationId, code),

      listTasks: ({ sessionId, branchId }) => core.listTasks(sessionId, branchId),

      actorSendUserMessage: (input) => actorProcess.sendUserMessage(input),

      actorSendToolResult: (input) => actorProcess.sendToolResult(input),

      actorInvokeTool: (input) => actorProcess.invokeTool(input),

      actorInterrupt: (input) => actorProcess.interrupt(input),

      actorGetState: ({ sessionId, branchId }) => actorProcess.getState({ sessionId, branchId }),

      actorGetMetrics: ({ sessionId, branchId }) =>
        actorProcess.getMetrics({ sessionId, branchId }),

      listSkills: () =>
        skills.list().pipe(
          Effect.map((list) =>
            list.map((s) => ({
              name: s.name,
              description: s.description,
              scope: s.scope,
              filePath: s.filePath,
              content: s.content,
            })),
          ),
        ),

      getSkillContent: ({ name }) =>
        skills.get(name).pipe(
          Effect.map((s) =>
            s !== undefined
              ? {
                  name: s.name,
                  description: s.description,
                  scope: s.scope,
                  filePath: s.filePath,
                  content: s.content,
                }
              : null,
          ),
        ),
    }
  }),
)
