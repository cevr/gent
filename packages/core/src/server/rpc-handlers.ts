import { Effect } from "effect"
import { withWideEvent, WideEvent, rpcBoundary } from "../runtime/wide-event-boundary"
import { GentRpcs } from "./rpcs"
import type { SteerCommand } from "../runtime/agent/agent-loop.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthApi, AuthStore } from "../domain/auth-store.js"
import { Permission } from "../domain/permission.js"
import { Skills } from "../domain/skills.js"
import { ActorProcess } from "../runtime/actor-process.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { SessionQueries } from "./session-queries.js"
import { SessionCommands } from "./session-commands.js"
import { SessionEvents } from "./session-events.js"
import { SessionSubscriptions } from "./session-subscriptions.js"
import { InteractionCommands } from "./interaction-commands.js"

// ============================================================================
// RPC Handlers Layer
// ============================================================================

export const RpcHandlersLive = GentRpcs.toLayer(
  Effect.gen(function* () {
    const queries = yield* SessionQueries
    const commands = yield* SessionCommands
    const events = yield* SessionEvents
    const subscriptions = yield* SessionSubscriptions
    const interactions = yield* InteractionCommands
    const skills = yield* Skills
    const askUserHandler = yield* AskUserHandler
    const permission = yield* Permission
    const configService = yield* ConfigService
    const actorProcess = yield* ActorProcess
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const extensionStateRuntime = yield* ExtensionStateRuntime

    return {
      createSession: (input) =>
        commands
          .createSession({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.bypass !== undefined ? { bypass: input.bypass } : {}),
            ...(input.parentSessionId !== undefined
              ? { parentSessionId: input.parentSessionId }
              : {}),
            ...(input.parentBranchId !== undefined ? { parentBranchId: input.parentBranchId } : {}),
            ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
            ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          })
          .pipe(
            Effect.tap((result) => WideEvent.set({ sessionId: result.sessionId })),
            withWideEvent(rpcBoundary("createSession", input.requestId)),
          ),

      listSessions: () => queries.listSessions(),

      getSession: ({ sessionId }) => queries.getSession(sessionId),

      deleteSession: ({ sessionId }) =>
        commands.deleteSession(sessionId).pipe(
          Effect.tap(() => WideEvent.set({ sessionId })),
          withWideEvent(rpcBoundary("deleteSession")),
        ),

      getChildSessions: ({ parentSessionId }) => queries.getChildSessions(parentSessionId),

      getSessionTree: ({ sessionId }) =>
        queries.getSessionTree(sessionId).pipe(
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

      listBranches: ({ sessionId }) => queries.listBranches(sessionId),

      createBranch: ({ sessionId, name }) =>
        commands.createBranch({
          sessionId,
          ...(name !== undefined ? { name } : {}),
        }),

      getBranchTree: ({ sessionId }) => queries.getBranchTree(sessionId),

      switchBranch: ({ sessionId, fromBranchId, toBranchId, summarize }) =>
        commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          ...(summarize !== undefined ? { summarize } : {}),
        }),

      forkBranch: ({ sessionId, fromBranchId, atMessageId, name }) =>
        commands.forkBranch({
          sessionId,
          fromBranchId,
          atMessageId,
          ...(name !== undefined ? { name } : {}),
        }),

      sendMessage: ({ sessionId, branchId, content, agentOverride, requestId }) =>
        commands
          .sendMessage({
            sessionId,
            branchId,
            content,
            ...(agentOverride !== undefined ? { agentOverride } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
          })
          .pipe(
            Effect.tap(() => WideEvent.set({ sessionId, branchId })),
            withWideEvent(rpcBoundary("sendMessage", requestId)),
          ),

      listMessages: ({ branchId }) => queries.listMessages(branchId),

      getSessionSnapshot: ({ sessionId, branchId }) =>
        queries.getSessionSnapshot({ sessionId, branchId }),

      // SAFETY: SteerPayload and SteerCommand are structurally identical Schema.Union types
      steer: ({ command }) => commands.steer(command as SteerCommand),

      drainQueuedMessages: ({ sessionId, branchId }) =>
        commands.drainQueuedMessages({ sessionId, branchId }),

      getQueuedMessages: ({ sessionId, branchId }) =>
        queries.getQueuedMessages({ sessionId, branchId }),

      streamEvents: ({ sessionId, branchId, after }) =>
        // Return the stream directly for streaming RPC
        events.streamEvents({
          sessionId,
          ...(branchId !== undefined ? { branchId } : {}),
          ...(after !== undefined ? { after } : {}),
        }),

      watchRuntime: ({ sessionId, branchId }) =>
        subscriptions.watchRuntime({ sessionId, branchId }),

      respondQuestions: ({ requestId, answers }) => askUserHandler.respond(requestId, answers),

      respondPermission: ({ requestId, decision, persist }) =>
        interactions.respondPermission({ requestId, decision, persist }),

      respondPrompt: ({ requestId, decision, content }) =>
        interactions.respondPrompt({
          requestId,
          decision,
          ...(content !== undefined ? { content } : {}),
        }),

      respondHandoff: ({ requestId, decision, reason }) =>
        interactions.respondHandoff({
          requestId,
          decision,
          ...(reason !== undefined ? { reason } : {}),
        }),

      updateSessionBypass: ({ sessionId, bypass }) =>
        commands.updateSessionBypass({ sessionId, bypass }),

      updateSessionReasoningLevel: ({ sessionId, reasoningLevel }) =>
        commands.updateSessionReasoningLevel({ sessionId, reasoningLevel }),

      getPermissionRules: () => configService.getPermissionRules(),

      deletePermissionRule: ({ tool, pattern }) =>
        Effect.gen(function* () {
          yield* configService.removePermissionRule(tool, pattern)
          yield* permission.removeRule(tool, pattern)
        }),

      listModels: () => modelRegistry.list(),

      listAuthProviders: () => authGuard.listProviders(),

      setAuthKey: ({ provider, key }) =>
        authStore
          .set(provider, new AuthApi({ type: "api", key }))
          .pipe(
            Effect.catchEager((e) =>
              Effect.logWarning("failed to set auth key").pipe(
                Effect.annotateLogs({ error: String(e) }),
              ),
            ),
          ),

      deleteAuthKey: ({ provider }) =>
        authStore
          .remove(provider)
          .pipe(
            Effect.catchEager((e) =>
              Effect.logWarning("failed to delete auth key").pipe(
                Effect.annotateLogs({ error: String(e) }),
              ),
            ),
          ),

      listAuthMethods: () => providerAuth.listMethods(),

      authorizeAuth: ({ sessionId, provider, method }) =>
        providerAuth
          .authorize(sessionId, provider, method)
          .pipe(Effect.map((result) => result ?? null)),

      callbackAuth: ({ sessionId, provider, method, authorizationId, code }) =>
        providerAuth.callback(sessionId, provider, method, authorizationId, code),

      listTasks: ({ sessionId, branchId }) => queries.listTasks(sessionId, branchId),

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

      sendExtensionIntent: ({ sessionId, extensionId, intent, epoch, branchId }) =>
        extensionStateRuntime
          .handleIntent(sessionId, extensionId, intent, epoch, branchId)
          .pipe(Effect.orDie),
    }
  }),
)
