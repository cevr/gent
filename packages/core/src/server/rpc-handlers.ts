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
      // -- session --
      "session.create": (input) =>
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
            withWideEvent(rpcBoundary("session.create", input.requestId)),
          ),

      "session.list": () => queries.listSessions(),

      "session.get": ({ sessionId }) => queries.getSession(sessionId),

      "session.delete": ({ sessionId }) =>
        commands.deleteSession(sessionId).pipe(
          Effect.tap(() => WideEvent.set({ sessionId })),
          withWideEvent(rpcBoundary("session.delete")),
        ),

      "session.getChildren": ({ parentSessionId }) => queries.getChildSessions(parentSessionId),

      "session.getTree": ({ sessionId }) =>
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

      "session.getSnapshot": ({ sessionId, branchId }) =>
        queries.getSessionSnapshot({ sessionId, branchId }),

      "session.updateBypass": ({ sessionId, bypass }) =>
        commands.updateSessionBypass({ sessionId, bypass }),

      "session.updateReasoningLevel": ({ sessionId, reasoningLevel }) =>
        commands.updateSessionReasoningLevel({ sessionId, reasoningLevel }),

      "session.events": ({ sessionId, branchId, after }) =>
        events.streamEvents({
          sessionId,
          ...(branchId !== undefined ? { branchId } : {}),
          ...(after !== undefined ? { after } : {}),
        }),

      "session.watchRuntime": ({ sessionId, branchId }) =>
        subscriptions.watchRuntime({ sessionId, branchId }),

      // -- branch --
      "branch.list": ({ sessionId }) => queries.listBranches(sessionId),

      "branch.create": ({ sessionId, name }) =>
        commands.createBranch({
          sessionId,
          ...(name !== undefined ? { name } : {}),
        }),

      "branch.getTree": ({ sessionId }) => queries.getBranchTree(sessionId),

      "branch.switch": ({ sessionId, fromBranchId, toBranchId, summarize }) =>
        commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          ...(summarize !== undefined ? { summarize } : {}),
        }),

      "branch.fork": ({ sessionId, fromBranchId, atMessageId, name }) =>
        commands.forkBranch({
          sessionId,
          fromBranchId,
          atMessageId,
          ...(name !== undefined ? { name } : {}),
        }),

      // -- message --
      "message.send": ({ sessionId, branchId, content, agentOverride, requestId }) =>
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
            withWideEvent(rpcBoundary("message.send", requestId)),
          ),

      "message.list": ({ branchId }) => queries.listMessages(branchId),

      // -- steer --
      // SAFETY: SteerPayload and SteerCommand are structurally identical Schema.Union types
      "steer.command": ({ command }) => commands.steer(command as SteerCommand),

      // -- queue --
      "queue.drain": ({ sessionId, branchId }) =>
        commands.drainQueuedMessages({ sessionId, branchId }),

      "queue.get": ({ sessionId, branchId }) => queries.getQueuedMessages({ sessionId, branchId }),

      // -- interaction --
      "interaction.respondQuestions": ({ requestId, answers }) =>
        askUserHandler.respond(requestId, answers),

      "interaction.respondPermission": ({ requestId, decision, persist }) =>
        interactions.respondPermission({ requestId, decision, persist }),

      "interaction.respondPrompt": ({ requestId, decision, content }) =>
        interactions.respondPrompt({
          requestId,
          decision,
          ...(content !== undefined ? { content } : {}),
        }),

      "interaction.respondHandoff": ({ requestId, decision, reason }) =>
        interactions.respondHandoff({
          requestId,
          decision,
          ...(reason !== undefined ? { reason } : {}),
        }),

      // -- permission --
      "permission.listRules": () => configService.getPermissionRules(),

      "permission.deleteRule": ({ tool, pattern }) =>
        Effect.gen(function* () {
          yield* configService.removePermissionRule(tool, pattern)
          yield* permission.removeRule(tool, pattern)
        }),

      // -- model --
      "model.list": () => modelRegistry.list(),

      // -- auth --
      "auth.listProviders": () => authGuard.listProviders(),

      "auth.setKey": ({ provider, key }) =>
        authStore
          .set(provider, new AuthApi({ type: "api", key }))
          .pipe(
            Effect.catchEager((e) =>
              Effect.logWarning("failed to set auth key").pipe(
                Effect.annotateLogs({ error: String(e) }),
              ),
            ),
          ),

      "auth.deleteKey": ({ provider }) =>
        authStore
          .remove(provider)
          .pipe(
            Effect.catchEager((e) =>
              Effect.logWarning("failed to delete auth key").pipe(
                Effect.annotateLogs({ error: String(e) }),
              ),
            ),
          ),

      "auth.listMethods": () => providerAuth.listMethods(),

      "auth.authorize": ({ sessionId, provider, method }) =>
        providerAuth
          .authorize(sessionId, provider, method)
          .pipe(Effect.map((result) => result ?? null)),

      "auth.callback": ({ sessionId, provider, method, authorizationId, code }) =>
        providerAuth.callback(sessionId, provider, method, authorizationId, code),

      // -- task --
      "task.list": ({ sessionId, branchId }) => queries.listTasks(sessionId, branchId),

      // -- skill --
      "skill.list": () =>
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

      "skill.getContent": ({ name }) =>
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

      // -- extension --
      "extension.sendIntent": ({ sessionId, extensionId, intent, epoch, branchId }) =>
        extensionStateRuntime
          .handleIntent(sessionId, extensionId, intent, epoch, branchId)
          .pipe(Effect.orDie),

      // -- actor --
      "actor.sendUserMessage": (input) => actorProcess.sendUserMessage(input),

      "actor.sendToolResult": (input) => actorProcess.sendToolResult(input),

      "actor.invokeTool": (input) => actorProcess.invokeTool(input),

      "actor.interrupt": (input) => actorProcess.interrupt(input),

      "actor.getState": ({ sessionId, branchId }) => actorProcess.getState({ sessionId, branchId }),

      "actor.getMetrics": ({ sessionId, branchId }) =>
        actorProcess.getMetrics({ sessionId, branchId }),
    }
  }),
)
