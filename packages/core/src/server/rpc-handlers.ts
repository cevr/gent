import { Effect } from "effect"
import { withWideEvent, WideEvent, rpcBoundary } from "../runtime/wide-event-boundary"
import { GentRpcs } from "./rpcs"
import type { SteerCommand } from "../runtime/agent/agent-loop.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
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
import { ExtensionEventBus } from "../runtime/extensions/event-bus.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { buildExtensionHealthSnapshot } from "./extension-health.js"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "../runtime/make-extension-host-context.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"
import { Storage } from "../storage/sqlite-storage.js"
import { SearchStorage } from "../storage/search-storage.js"
import { AgentRunnerService } from "../domain/agent.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { toExtensionContext } from "../domain/extension-context.js"

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
    const permission = yield* Permission
    const configService = yield* ConfigService
    const actorProcess = yield* ActorProcess
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const extensionStateRuntime = yield* ExtensionStateRuntime
    const extensionRegistry = yield* ExtensionRegistry
    const busOpt = yield* Effect.serviceOption(ExtensionEventBus)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined

    return {
      // -- session --
      "session.create": (input) =>
        commands
          .createSession({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
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
      "interaction.respondInteraction": ({ requestId, sessionId, branchId, approved, notes }) =>
        interactions.respond({
          requestId,
          sessionId,
          branchId,
          approved,
          ...(notes !== undefined ? { notes } : {}),
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
      "auth.listProviders": ({ agentName }) =>
        authGuard.listProviders({
          ...(agentName !== undefined ? { agentName } : {}),
        }),

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

      // -- extension --
      "extension.listStatus": ({ sessionId }) =>
        Effect.gen(function* () {
          const activationStatuses = yield* extensionRegistry.listExtensionStatuses()
          const actorStatuses =
            sessionId === undefined ? [] : yield* extensionStateRuntime.getActorStatuses(sessionId)
          return buildExtensionHealthSnapshot(activationStatuses, actorStatuses)
        }),

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
      "extension.send": ({ sessionId, message, branchId }) =>
        extensionStateRuntime.send(sessionId, message, branchId).pipe(
          Effect.tap(() => {
            if (bus === undefined) return Effect.void
            return bus
              .emit({
                channel: `${message.extensionId}:${message._tag}`,
                payload: message,
                sessionId,
                branchId,
              })
              .pipe(Effect.catchEager(() => Effect.void))
          }),
        ),

      "extension.ask": ({ sessionId, message, branchId }) =>
        extensionStateRuntime.ask(sessionId, message, branchId),

      "extension.listCommands": () =>
        extensionRegistry
          .listCommands()
          .pipe(
            Effect.map((cmds) => cmds.map((c) => ({ name: c.name, description: c.description }))),
          ),

      "extension.invokeCommand": ({ name, args, sessionId, branchId }) =>
        Effect.gen(function* () {
          const cmds = yield* extensionRegistry.listCommands()
          const cmd = cmds.find((c) => c.name === name)
          if (cmd === undefined) {
            return yield* Effect.die(`Unknown command: ${name}`)
          }

          // Resolve deps lazily for host context (same pattern as tool-runner)
          const lazyDeps = yield* Effect.all({
            platform: Effect.serviceOption(RuntimePlatform),
            approvalService: Effect.serviceOption(ApprovalService),
            promptPresenter: Effect.serviceOption(PromptPresenter),
            turnControl: Effect.serviceOption(ExtensionTurnControl),
            storage: Effect.serviceOption(Storage),
            searchStorage: Effect.serviceOption(SearchStorage),
            agentRunner: Effect.serviceOption(AgentRunnerService),
            eventPublisher: Effect.serviceOption(EventPublisher),
          })

          const die = (label: string) => () => Effect.die(`${label} not available in invokeCommand`)
          const hostDeps: MakeExtensionHostContextDeps = {
            platform:
              lazyDeps.platform._tag === "Some"
                ? lazyDeps.platform.value
                : ({ cwd: "/", home: "/" } as MakeExtensionHostContextDeps["platform"]),
            extensionStateRuntime,
            approvalService:
              lazyDeps.approvalService._tag === "Some"
                ? lazyDeps.approvalService.value
                : ({
                    present: die("ApprovalService"),
                    storeResolution: die("ApprovalService"),
                    respond: die("ApprovalService"),
                    rehydrate: die("ApprovalService"),
                  } as MakeExtensionHostContextDeps["approvalService"]),
            promptPresenter:
              lazyDeps.promptPresenter._tag === "Some"
                ? lazyDeps.promptPresenter.value
                : ({
                    present: die("PromptPresenter"),
                    confirm: die("PromptPresenter"),
                    review: die("PromptPresenter"),
                  } as MakeExtensionHostContextDeps["promptPresenter"]),
            extensionRegistry,
            turnControl:
              lazyDeps.turnControl._tag === "Some"
                ? lazyDeps.turnControl.value
                : ({
                    queueFollowUp: die("TurnControl"),
                    interject: die("TurnControl"),
                    bind: die("TurnControl"),
                  } as MakeExtensionHostContextDeps["turnControl"]),
            storage:
              lazyDeps.storage._tag === "Some"
                ? lazyDeps.storage.value
                : ({} as MakeExtensionHostContextDeps["storage"]),
            searchStorage:
              lazyDeps.searchStorage._tag === "Some"
                ? lazyDeps.searchStorage.value
                : ({
                    searchMessages: () => Effect.succeed([]),
                  } as MakeExtensionHostContextDeps["searchStorage"]),
            agentRunner:
              lazyDeps.agentRunner._tag === "Some"
                ? lazyDeps.agentRunner.value
                : ({
                    run: die("AgentRunnerService"),
                  } as MakeExtensionHostContextDeps["agentRunner"]),
            eventPublisher:
              lazyDeps.eventPublisher._tag === "Some"
                ? lazyDeps.eventPublisher.value
                : ({
                    publish: () => Effect.void,
                    terminateSession: die("EventPublisher"),
                  } as MakeExtensionHostContextDeps["eventPublisher"]),
          }

          const hostCtx = makeExtensionHostContext({ sessionId, branchId }, hostDeps)
          const ctx = toExtensionContext(hostCtx)
          yield* Effect.promise(() => Promise.resolve(cmd.handler(args, ctx)))
        }),

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
