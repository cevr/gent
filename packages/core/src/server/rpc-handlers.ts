import { Clock, Effect } from "effect"
import { BranchId, SessionId } from "../domain/ids.js"
import { withWideEvent, WideEvent, rpcBoundary } from "../runtime/wide-event-boundary"
import { ExtensionProtocolError } from "../domain/extension-protocol.js"
import { GentRpcs } from "./rpcs"
import type { SteerCommand } from "../runtime/agent/agent-loop.js"
import { MachineEngine } from "../runtime/extensions/resource-host/machine-engine.js"
import { AuthGuard } from "../domain/auth-guard.js"
import { AuthApi, AuthStore } from "../domain/auth-store.js"
import { Permission } from "../domain/permission.js"
import { ActorProcess } from "../runtime/actor-process.js"
import { ConfigService } from "../runtime/config-service.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { SessionQueries } from "./session-queries.js"
import { SessionCommands } from "./session-commands.js"
import { SessionEvents } from "./session-events.js"
import { SessionSubscriptions } from "./session-subscriptions.js"
import { InteractionCommands } from "./interaction-commands.js"
import { SubscriptionEngine } from "../runtime/extensions/resource-host/subscription-engine.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { buildExtensionHealthSnapshot } from "./extension-health.js"
import {
  makeExtensionHostContext,
  unavailableHostDeps,
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
import { SessionProfileCache } from "../runtime/session-profile.js"
import { ConnectionTracker } from "./connection-tracker.js"
import { ServerIdentity } from "./server-identity.js"

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
    const permission = yield* Permission
    const configService = yield* ConfigService
    const actorProcess = yield* ActorProcess
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const extensionStateRuntime = yield* MachineEngine
    const extensionRegistry = yield* ExtensionRegistry
    const platform = yield* RuntimePlatform
    const busOpt = yield* Effect.serviceOption(SubscriptionEngine)
    const bus = busOpt._tag === "Some" ? busOpt.value : undefined
    const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
    const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined
    const storageForProfile = yield* Effect.serviceOption(Storage)

    /** Resolve per-session profile services. Falls back to server-wide. */
    const resolveSessionProfile = (sessionId: string) =>
      Effect.gen(function* () {
        if (profileCache === undefined || storageForProfile._tag !== "Some") {
          return { registry: extensionRegistry, stateRuntime: extensionStateRuntime }
        }
        const session = yield* storageForProfile.value
          .getSession(SessionId.of(sessionId))
          .pipe(Effect.orElseSucceed(() => undefined))
        if (session?.cwd === undefined) {
          return { registry: extensionRegistry, stateRuntime: extensionStateRuntime }
        }
        const profile = yield* profileCache.resolve(session.cwd)
        return {
          registry: profile.registryService,
          stateRuntime: profile.extensionStateRuntime,
        }
      })

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
      "message.send": ({ sessionId, branchId, content, agentOverride, runSpec, requestId }) =>
        commands
          .sendMessage({
            sessionId,
            branchId,
            content,
            ...(agentOverride !== undefined ? { agentOverride } : {}),
            ...(runSpec !== undefined ? { runSpec } : {}),
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
          const profile =
            sessionId !== undefined ? yield* resolveSessionProfile(sessionId) : undefined
          const activeRegistry = profile?.registry ?? extensionRegistry
          const activeRuntime = profile?.stateRuntime ?? extensionStateRuntime
          const activationStatuses = yield* activeRegistry.listExtensionStatuses()
          const actorStatuses =
            sessionId === undefined ? [] : yield* activeRuntime.getActorStatuses(sessionId)
          return buildExtensionHealthSnapshot(activationStatuses, actorStatuses)
        }),

      // -- extension --
      "extension.send": ({ sessionId, message, branchId }) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("rpc.extension.send.received").pipe(
            Effect.annotateLogs({
              sessionId,
              extensionId: message.extensionId,
              tag: message._tag,
              branchId,
            }),
          )
          const { stateRuntime: activeRuntime } = yield* resolveSessionProfile(sessionId)
          yield* activeRuntime.send(sessionId, message, branchId)
          if (bus !== undefined) {
            yield* bus
              .emit({
                channel: `${message.extensionId}:${message._tag}`,
                payload: message,
                sessionId,
                branchId,
              })
              .pipe(Effect.catchEager(() => Effect.void))
          }
        }),

      "extension.ask": ({ sessionId, message, branchId }) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("rpc.extension.ask.received").pipe(
            Effect.annotateLogs({
              sessionId,
              extensionId: message.extensionId,
              tag: message._tag,
              branchId,
            }),
          )
          const { stateRuntime: askRuntime } = yield* resolveSessionProfile(sessionId)
          const reply = yield* askRuntime.execute(sessionId, message, branchId)
          yield* Effect.logDebug("rpc.extension.ask.replied").pipe(
            Effect.annotateLogs({
              sessionId,
              extensionId: message.extensionId,
              tag: message._tag,
            }),
          )
          return reply
        }),

      "extension.query": ({ sessionId, extensionId, queryId, input, branchId }) =>
        Effect.gen(function* () {
          const { registry: activeRegistry } = yield* resolveSessionProfile(sessionId)
          const capabilities = activeRegistry.getResolved().capabilities
          return yield* capabilities
            .run(
              extensionId,
              queryId,
              "agent-protocol",
              input,
              {
                sessionId: SessionId.of(sessionId),
                branchId: BranchId.of(branchId),
                cwd: platform.cwd,
                home: platform.home,
              },
              { intent: "read" },
            )
            .pipe(
              Effect.mapError(
                (e) =>
                  new ExtensionProtocolError({
                    extensionId,
                    tag: queryId,
                    phase: "request",
                    message: "reason" in e ? `${e._tag}: ${e.reason}` : e._tag,
                  }),
              ),
            )
        }),

      "extension.mutate": ({ sessionId, extensionId, mutationId, input, branchId }) =>
        Effect.gen(function* () {
          const { registry: activeRegistry } = yield* resolveSessionProfile(sessionId)
          const capabilities = activeRegistry.getResolved().capabilities
          return yield* capabilities
            .run(
              extensionId,
              mutationId,
              "agent-protocol",
              input,
              {
                sessionId: SessionId.of(sessionId),
                branchId: BranchId.of(branchId),
                cwd: platform.cwd,
                home: platform.home,
              },
              { intent: "write" },
            )
            .pipe(
              Effect.mapError(
                (e) =>
                  new ExtensionProtocolError({
                    extensionId,
                    tag: mutationId,
                    phase: "request",
                    message: "reason" in e ? `${e._tag}: ${e.reason}` : e._tag,
                  }),
              ),
            )
        }),

      "extension.listCommands": () =>
        extensionRegistry
          .listCommands()
          .pipe(
            Effect.map((cmds) => cmds.map((c) => ({ name: c.name, description: c.description }))),
          ),

      "extension.invokeCommand": ({ name, args, sessionId, branchId }) =>
        Effect.gen(function* () {
          const { registry: activeRegistry, stateRuntime: activeStateRuntime } =
            yield* resolveSessionProfile(sessionId)

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

          const cmdSession =
            storageForProfile._tag === "Some"
              ? yield* storageForProfile.value
                  .getSession(sessionId)
                  .pipe(Effect.orElseSucceed(() => undefined))
              : undefined

          const cmds = yield* activeRegistry.listCommands()
          const cmd = cmds.find((c) => c.name === name)
          if (cmd === undefined) {
            return yield* Effect.die(`Unknown command: ${name}`)
          }

          const fallback = unavailableHostDeps("invokeCommand")
          const hostDeps: MakeExtensionHostContextDeps = {
            platform:
              lazyDeps.platform._tag === "Some" ? lazyDeps.platform.value : fallback.platform,
            extensionStateRuntime: activeStateRuntime,
            approvalService:
              lazyDeps.approvalService._tag === "Some"
                ? lazyDeps.approvalService.value
                : fallback.approvalService,
            promptPresenter:
              lazyDeps.promptPresenter._tag === "Some"
                ? lazyDeps.promptPresenter.value
                : fallback.promptPresenter,
            extensionRegistry: activeRegistry,
            turnControl:
              lazyDeps.turnControl._tag === "Some"
                ? lazyDeps.turnControl.value
                : fallback.turnControl,
            storage: lazyDeps.storage._tag === "Some" ? lazyDeps.storage.value : fallback.storage,
            searchStorage:
              lazyDeps.searchStorage._tag === "Some"
                ? lazyDeps.searchStorage.value
                : fallback.searchStorage,
            agentRunner:
              lazyDeps.agentRunner._tag === "Some"
                ? lazyDeps.agentRunner.value
                : fallback.agentRunner,
            eventPublisher:
              lazyDeps.eventPublisher._tag === "Some"
                ? lazyDeps.eventPublisher.value
                : fallback.eventPublisher,
          }

          const hostCtx = makeExtensionHostContext(
            { sessionId, branchId, sessionCwd: cmdSession?.cwd },
            hostDeps,
          )
          yield* cmd.handler(args, hostCtx)
        }),

      // -- actor --
      "actor.sendUserMessage": (input) => actorProcess.sendUserMessage(input),

      "actor.sendToolResult": (input) => actorProcess.sendToolResult(input),

      "actor.invokeTool": (input) => actorProcess.invokeTool(input),

      "actor.interrupt": (input) => actorProcess.interrupt(input),

      "actor.getState": ({ sessionId, branchId }) => actorProcess.getState({ sessionId, branchId }),

      "actor.getMetrics": ({ sessionId, branchId }) =>
        actorProcess.getMetrics({ sessionId, branchId }),

      // -- server --
      "server.status": () =>
        Effect.gen(function* () {
          const identityOpt = yield* Effect.serviceOption(ServerIdentity)
          const trackerOpt = yield* Effect.serviceOption(ConnectionTracker)
          if (identityOpt._tag !== "Some") {
            return yield* Effect.die("ServerIdentity not available")
          }
          const identity = identityOpt.value
          const connectionCount = trackerOpt._tag === "Some" ? yield* trackerOpt.value.count() : 0
          return {
            serverId: identity.serverId,
            pid: identity.pid,
            hostname: identity.hostname,
            uptime: (yield* Clock.currentTimeMillis) - identity.startedAt,
            connectionCount,
            dbPath: identity.dbPath,
            buildFingerprint: identity.buildFingerprint,
          }
        }),
    }
  }),
)
