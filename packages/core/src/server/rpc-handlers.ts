import { Clock, Effect, Layer, Stream, type Context } from "effect"
import { GentRpcs } from "./rpcs"
import type { DriverRef } from "../domain/agent.js"
import { Auth, AuthApi, AuthGuard } from "../domain/auth.js"
import { ProviderAuthError } from "../domain/driver.js"
import { EventId, EventStore, type EventEnvelope } from "../domain/event.js"
import { ExtensionProtocolError } from "../domain/extension-protocol.js"
import { RpcId, SessionId, type BranchId, type ExtensionId } from "../domain/ids.js"
import type { Session } from "../domain/message.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ConfigService } from "../runtime/config-service.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import {
  ExtensionRegistry,
  listSlashCommands,
  type ExtensionRegistryService,
} from "../runtime/extensions/registry.js"
import { makeExtensionHostPlatform } from "../runtime/extensions/host-platform.js"
import {
  makeAmbientExtensionHostContextDeps,
  makeExtensionHostContext,
} from "../runtime/make-extension-host-context.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { WideEvent, rpcBoundary, withWideEvent } from "../runtime/wide-event-boundary.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { ConnectionTracker } from "./connection-tracker.js"
import { NotFoundError } from "./errors.js"
import { buildExtensionHealthSnapshot } from "./extension-health.js"
import { InteractionCommands } from "./interaction-commands.js"
import { ServerIdentity } from "./server-identity.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"
import { WorkspaceRpcMiddleware } from "./workspace-rpc.js"
import {
  DriverInfo,
  DriverListResult,
  SlashCommandInfo,
  type AuthorizeAuthInput,
  type CallbackAuthInput,
  type ClearDriverOverrideInput,
  type CreateBranchInput,
  type CreateSessionInput,
  type DeleteAuthKeyInput,
  type DeletePermissionRuleInput,
  type ExtensionRpcRequestInput,
  type ForkBranchInput,
  type GetSessionSnapshotInput,
  type ListAuthProvidersInput,
  type QueueDrainInput,
  type QueueTarget,
  type RespondInteractionInput,
  type SendMessageInput,
  type SetAuthKeyInput,
  type SetDriverOverrideInput,
  type SteerCommand as TransportSteerCommand,
  type SubscribeEventsInput,
  type SwitchBranchInput,
  type UpdateSessionReasoningLevelInput,
} from "./transport-contract.js"

// ============================================================================
// Handler helpers (yield Tags inside; no service-bag threading)
// ============================================================================

interface ResolvedSessionServices {
  readonly registry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
}

const isPublicTransportEvent = (envelope: EventEnvelope) =>
  envelope.event._tag !== "MachineTaskSucceeded" && envelope.event._tag !== "MachineTaskFailed"

const invalidateExternalDriversFor = (prev: DriverRef | undefined, next: DriverRef | undefined) =>
  Effect.gen(function* () {
    const registry = yield* DriverRegistry
    const ids = new Set<string>()
    if (prev?._tag === "external") ids.add(prev.id)
    if (next?._tag === "external") ids.add(next.id)
    for (const id of ids) {
      const driver = yield* registry.getExternal(id)
      if (driver !== undefined) yield* driver.invalidate()
    }
  })

type ParentSessionPayload = { readonly parentSessionId: SessionId }
type BranchPayload = { readonly branchId: BranchId }
type OptionalSessionPayload = { readonly sessionId?: SessionId }
type SessionIdPayload = { readonly sessionId: SessionId }

const watchRuntimeStream = ({ sessionId, branchId }: QueueTarget) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sessionRuntime = yield* SessionRuntime
      const stateStream = yield* sessionRuntime.watchState({ sessionId, branchId })
      yield* Effect.logInfo("watchRuntime.open").pipe(Effect.annotateLogs({ sessionId, branchId }))
      return stateStream.pipe(
        Stream.ensuring(
          Effect.logInfo("watchRuntime.close").pipe(Effect.annotateLogs({ sessionId, branchId })),
        ),
      )
    }),
  )

const authPersistenceError = (
  action: "read" | "set" | "delete",
  provider: string,
  cause: unknown,
): ProviderAuthError =>
  new ProviderAuthError({
    message: `Failed to ${action} auth for provider "${provider}"`,
    cause,
  })

const extensionRequestError = (params: {
  readonly extensionId: ExtensionId
  readonly capabilityId: string
  readonly phase?: "command" | "request"
  readonly message: string
}) =>
  new ExtensionProtocolError({
    extensionId: params.extensionId,
    tag: params.capabilityId,
    phase: params.phase ?? "request",
    message: params.message,
  })

const resolveExtensionSession = (params: {
  readonly extensionId: ExtensionId
  readonly tag: string
  readonly phase: "command" | "request"
  readonly sessionId: SessionId
  readonly branchId: BranchId
}): Effect.Effect<
  { readonly sessionId: SessionId; readonly branchId: BranchId; readonly session: Session },
  ExtensionProtocolError,
  SessionStorage | BranchStorage
> =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const requestSessionId = params.sessionId
    const requestBranchId = params.branchId
    const session = yield* sessionStorage.getSession(requestSessionId).pipe(
      Effect.mapError((error) =>
        extensionRequestError({
          extensionId: params.extensionId,
          capabilityId: params.tag,
          phase: params.phase,
          message: `Session lookup failed: ${error.message}`,
        }),
      ),
    )
    if (session === undefined) {
      return yield* extensionRequestError({
        extensionId: params.extensionId,
        capabilityId: params.tag,
        phase: params.phase,
        message: "Session not found for extension transport",
      })
    }

    const branch = yield* branchStorage.getBranch(requestBranchId).pipe(
      Effect.mapError((error) =>
        extensionRequestError({
          extensionId: params.extensionId,
          capabilityId: params.tag,
          phase: params.phase,
          message: `Branch lookup failed: ${error.message}`,
        }),
      ),
    )
    if (branch === undefined || branch.sessionId !== requestSessionId) {
      return yield* extensionRequestError({
        extensionId: params.extensionId,
        capabilityId: params.tag,
        phase: params.phase,
        message: "Branch does not belong to extension transport session",
      })
    }

    return { sessionId: requestSessionId, branchId: requestBranchId, session }
  })

// ============================================================================
// RPC Handlers Layer
// ============================================================================

const RpcHandlers = GentRpcs.toLayer(
  Effect.gen(function* () {
    const queries = yield* SessionQueries
    const commands = yield* SessionCommands
    const eventStore = yield* EventStore
    const interactions = yield* InteractionCommands
    const configService = yield* ConfigService
    const sessionRuntime = yield* SessionRuntime
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* Auth
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const extensionRegistry = yield* ExtensionRegistry
    const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
    const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined
    const sessionStorage = yield* SessionStorage
    const connectionTrackerOpt = yield* Effect.serviceOption(ConnectionTracker)
    const connectionTracker =
      connectionTrackerOpt._tag === "Some" ? connectionTrackerOpt.value : undefined
    const serverIdentity = yield* ServerIdentity
    // Touching RuntimeEnvironment ensures the layer requirement is preserved
    // for downstream callers that depend on the runtime being initialized.
    yield* RuntimeEnvironment

    const loadSession = (sessionId: string) =>
      sessionStorage
        .getSession(SessionId.make(sessionId))
        .pipe(Effect.orElseSucceed(() => undefined))

    const resolveProfileServices = (
      cwd: string | undefined,
    ): Effect.Effect<ResolvedSessionServices> =>
      Effect.gen(function* () {
        if (cwd === undefined || profileCache === undefined) {
          return {
            registry: extensionRegistry,
          }
        }
        const profile = yield* profileCache.resolve(cwd)
        return {
          registry: profile.registryService,
          capabilityContext: profile.layerContext,
        }
      })

    const resolveSessionServices = (
      sessionId: string | undefined,
    ): Effect.Effect<ResolvedSessionServices> =>
      Effect.gen(function* () {
        if (sessionId === undefined) return yield* resolveProfileServices(undefined)
        const session = yield* loadSession(sessionId)
        return yield* resolveProfileServices(session?.cwd)
      })

    return {
      // ----------------------------------------------------------------------
      // Session / branch / message / queue / interaction
      // ----------------------------------------------------------------------
      "session.create": (input: CreateSessionInput) =>
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

      "session.get": ({ sessionId }: SessionIdPayload) => queries.getSession(sessionId),

      "session.delete": ({ sessionId }: SessionIdPayload) =>
        commands.deleteSession(sessionId).pipe(
          Effect.tap(() => WideEvent.set({ sessionId })),
          withWideEvent(rpcBoundary("session.delete")),
        ),

      "session.getChildren": ({ parentSessionId }: ParentSessionPayload) =>
        queries.getChildSessions(parentSessionId),

      "session.getTree": ({ sessionId }: SessionIdPayload) => queries.getSessionTree(sessionId),

      "session.getSnapshot": ({ sessionId, branchId }: GetSessionSnapshotInput) =>
        queries.getSessionSnapshot({ sessionId, branchId }),

      "session.updateReasoningLevel": ({
        sessionId,
        reasoningLevel,
      }: UpdateSessionReasoningLevelInput) =>
        commands.updateSessionReasoningLevel({ sessionId, reasoningLevel }),

      "session.events": ({ sessionId, branchId, after }: SubscribeEventsInput) =>
        eventStore
          .subscribe({
            sessionId,
            ...(branchId !== undefined ? { branchId } : {}),
            ...(after !== undefined ? { after: EventId.make(after) } : {}),
          })
          .pipe(Stream.filter(isPublicTransportEvent)),

      "session.watchRuntime": (input: QueueTarget) => watchRuntimeStream(input),

      "branch.list": ({ sessionId }: SessionIdPayload) => queries.listBranches(sessionId),

      "branch.create": ({ sessionId, name, requestId }: CreateBranchInput) =>
        commands.createBranch({
          sessionId,
          ...(name !== undefined ? { name } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        }),

      "branch.getTree": ({ sessionId }: SessionIdPayload) => queries.getBranchTree(sessionId),

      "branch.switch": ({
        sessionId,
        fromBranchId,
        toBranchId,
        summarize,
        requestId,
      }: SwitchBranchInput) =>
        commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          ...(summarize !== undefined ? { summarize } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        }),

      "branch.fork": ({ sessionId, fromBranchId, atMessageId, name, requestId }: ForkBranchInput) =>
        commands.forkBranch({
          sessionId,
          fromBranchId,
          atMessageId,
          ...(name !== undefined ? { name } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        }),

      "message.send": ({
        sessionId,
        branchId,
        content,
        agentOverride,
        runSpec,
        requestId,
      }: SendMessageInput) =>
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

      "message.list": ({ branchId }: BranchPayload) => queries.listMessages(branchId),

      "steer.command": ({ command }: { readonly command: TransportSteerCommand }) =>
        commands.steer(command),

      "queue.drain": ({ sessionId, branchId, requestId }: QueueDrainInput) =>
        commands.drainQueuedMessages({ sessionId, branchId, requestId }),

      "queue.get": ({ sessionId, branchId }: QueueTarget) =>
        queries.getQueuedMessages({ sessionId, branchId }),

      "interaction.respondInteraction": ({
        requestId,
        sessionId,
        branchId,
        approved,
        notes,
      }: RespondInteractionInput) =>
        interactions.respond({
          requestId,
          sessionId,
          branchId,
          approved,
          ...(notes !== undefined ? { notes } : {}),
        }),

      // ----------------------------------------------------------------------
      // Config / driver / model / auth / permission
      // ----------------------------------------------------------------------
      "permission.listRules": () => configService.getPermissionRules(),

      "permission.deleteRule": ({ tool, pattern }: DeletePermissionRuleInput) =>
        configService.removePermissionRule(tool, pattern),

      "model.list": () => modelRegistry.list(),

      "driver.list": () =>
        Effect.gen(function* () {
          const config = yield* configService.get()
          const driverRegistry = yield* DriverRegistry
          const models = yield* driverRegistry.listModels()
          const externals = yield* driverRegistry.listExternal()
          const agents = yield* extensionRegistry.listAgents()
          const drivers = [
            ...models.map((driver) =>
              DriverInfo.Model.make({
                id: driver.id,
                ...(driver.name !== undefined ? { description: driver.name } : {}),
              }),
            ),
            ...externals.map((driver) =>
              DriverInfo.External.make({
                id: driver.id,
              }),
            ),
          ]
          return new DriverListResult({
            drivers,
            overrides: config.driverOverrides ?? {},
            agents,
          })
        }),

      "driver.set": ({ agentName, driver }: SetDriverOverrideInput) =>
        Effect.gen(function* () {
          const driverRegistry = yield* DriverRegistry
          if (driver._tag === "model" && driver.id !== undefined) {
            const found = yield* driverRegistry.getModel(driver.id)
            if (found === undefined) {
              return yield* new NotFoundError({
                entity: "driver",
                message: `Unknown model driver "${driver.id}"`,
              })
            }
          }
          if (driver._tag === "external") {
            const found = yield* driverRegistry.getExternal(driver.id)
            if (found === undefined) {
              return yield* new NotFoundError({
                entity: "driver",
                message: `Unknown external driver "${driver.id}"`,
              })
            }
          }

          const prevConfig = yield* configService.get()
          const prevOverride = prevConfig.driverOverrides?.[agentName]
          yield* configService.setDriverOverride(agentName, driver)
          yield* invalidateExternalDriversFor(prevOverride, driver)
        }),

      "driver.clear": ({ agentName }: ClearDriverOverrideInput) =>
        Effect.gen(function* () {
          const prevConfig = yield* configService.get()
          const prevOverride = prevConfig.driverOverrides?.[agentName]
          yield* configService.clearDriverOverride(agentName)
          yield* invalidateExternalDriversFor(prevOverride, undefined)
        }),

      "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersInput) =>
        Effect.gen(function* () {
          let cwd: string | undefined
          if (sessionId !== undefined) {
            const session = yield* sessionStorage.getSession(SessionId.make(sessionId))
            if (session === undefined) {
              return yield* new NotFoundError({
                entity: "session",
                message: "Session not found",
              })
            }
            cwd = session?.cwd
          }
          const config = yield* configService.get(cwd)
          return yield* authGuard
            .listProviders({
              ...(agentName !== undefined ? { agentName } : {}),
              ...(sessionId !== undefined ? { sessionId } : {}),
              ...(config.driverOverrides !== undefined
                ? { driverOverrides: config.driverOverrides }
                : {}),
            })
            .pipe(Effect.mapError((error) => authPersistenceError("read", "*", error)))
        }),

      "auth.setKey": ({ provider, key }: SetAuthKeyInput) =>
        authStore
          .set(provider, new AuthApi({ type: "api", key }))
          .pipe(Effect.mapError((error) => authPersistenceError("set", provider, error))),

      "auth.deleteKey": ({ provider }: DeleteAuthKeyInput) =>
        authStore
          .remove(provider)
          .pipe(Effect.mapError((error) => authPersistenceError("delete", provider, error))),

      "auth.listMethods": () => providerAuth.listMethods(),

      "auth.authorize": ({ sessionId, provider, method }: AuthorizeAuthInput) =>
        providerAuth
          .authorize(sessionId, provider, method)
          .pipe(Effect.map((result) => result ?? null)),

      "auth.callback": ({
        sessionId,
        provider,
        method,
        authorizationId,
        code,
      }: CallbackAuthInput) =>
        providerAuth.callback(sessionId, provider, method, authorizationId, code),

      // ----------------------------------------------------------------------
      // Extension transport
      // ----------------------------------------------------------------------
      "extension.listStatus": ({ sessionId }: OptionalSessionPayload) =>
        Effect.gen(function* () {
          const { registry } = yield* resolveSessionServices(sessionId)
          const activationStatuses = yield* registry.listExtensionStatuses()
          return buildExtensionHealthSnapshot(activationStatuses)
        }),

      "extension.request": ({
        sessionId,
        extensionId,
        capabilityId,
        input,
        branchId,
      }: ExtensionRpcRequestInput) =>
        Effect.gen(function* () {
          const scope = yield* resolveExtensionSession({
            extensionId,
            tag: capabilityId,
            phase: "request",
            sessionId,
            branchId,
          })
          if (scope.session.cwd === undefined) {
            return yield* extensionRequestError({
              extensionId,
              capabilityId,
              message: "Session cwd unavailable for extension request",
            })
          }
          const { registry, capabilityContext } = yield* resolveProfileServices(scope.session.cwd)
          // Public write request handlers may ask for the wide host surface
          // (`session.*`, `agent.*`, storage, etc.). Build the full
          // ExtensionHostContext here so handlers use the same boundary as tools.
          const host = yield* makeExtensionHostPlatform
          const hostDeps = yield* makeAmbientExtensionHostContextDeps({
            extensionRegistry: registry,
            ...(capabilityContext !== undefined ? { capabilityContext } : {}),
            overrides: {
              host,
              sessionControl: {
                queueFollowUp: (input) => sessionRuntime.queueFollowUp(input),
              },
            },
          })
          const hostCtx = makeExtensionHostContext(
            {
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              sessionCwd: scope.session.cwd,
            },
            hostDeps,
          )
          const rpcRegistry = registry.getResolved().rpcRegistry
          const request = rpcRegistry
            .run(extensionId, RpcId.make(capabilityId), input, hostCtx)
            .pipe(
              Effect.mapError((error) =>
                extensionRequestError({
                  extensionId,
                  capabilityId,
                  message: "reason" in error ? `${error._tag}: ${error.reason}` : error._tag,
                }),
              ),
            )
          return yield* capabilityContext !== undefined
            ? request.pipe(Effect.provideContext(capabilityContext))
            : request
        }),

      "extension.listSlashCommands": ({ sessionId }: SessionIdPayload) =>
        Effect.gen(function* () {
          const { registry } = yield* resolveSessionServices(sessionId)
          return listSlashCommands(registry.getResolved()).map(
            (command) =>
              new SlashCommandInfo({
                name: command.name,
                displayName: command.displayName,
                description: command.description,
                category: command.category,
                keybind: command.keybind,
                extensionId: command.extensionId,
                capabilityId: command.capabilityId,
              }),
          )
        }),

      // ----------------------------------------------------------------------
      // Runtime status
      // ----------------------------------------------------------------------
      "runtime.status": () =>
        Effect.gen(function* () {
          const connectionCount =
            connectionTracker !== undefined ? yield* connectionTracker.count() : 0
          return {
            serverId: serverIdentity.serverId,
            pid: serverIdentity.pid,
            hostname: serverIdentity.hostname,
            uptime: (yield* Clock.currentTimeMillis) - serverIdentity.startedAt,
            connectionCount,
            dbPath: serverIdentity.dbPath,
            buildFingerprint: serverIdentity.buildFingerprint,
          }
        }),
    }
  }),
)

export const RpcHandlersLive = Layer.merge(RpcHandlers, WorkspaceRpcMiddleware.Live)
