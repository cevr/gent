import { Clock, Effect, Layer, Stream, type Context } from "effect"
import { GentRpcs } from "./rpcs"
import type { DriverRef } from "../domain/agent.js"
import {
  Auth,
  AuthApi,
  AuthGuard,
  type AuthGuardService,
  type AuthService,
} from "../domain/auth.js"
import { ProviderAuthError } from "../domain/driver.js"
import { EventId, EventStore, type EventEnvelope, type EventStoreService } from "../domain/event.js"
import { ExtensionProtocolError } from "../domain/extension-protocol.js"
import { RpcId, SessionId, type BranchId, type ExtensionId } from "../domain/ids.js"
import type { Session } from "../domain/message.js"
import { ProviderAuth, type ProviderAuthService } from "../providers/provider-auth.js"
import { ConfigService, type ConfigServiceService } from "../runtime/config-service.js"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../runtime/extensions/driver-registry.js"
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
import { ModelRegistry, type ModelRegistryService } from "../runtime/model-registry.js"
import { RuntimeEnvironment, type RuntimeEnvironmentShape } from "../runtime/runtime-environment.js"
import { SessionRuntime, type SessionRuntimeService } from "../runtime/session-runtime.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { WideEvent, rpcBoundary, withWideEvent } from "../runtime/wide-event-boundary.js"
import { BranchStorage, type BranchStorageService } from "../storage/branch-storage.js"
import { SessionStorage, type SessionStorageService } from "../storage/session-storage.js"
import { ConnectionTracker, type ConnectionTrackerService } from "./connection-tracker.js"
import { NotFoundError } from "./errors.js"
import { buildExtensionHealthSnapshot } from "./extension-health.js"
import { InteractionCommands, type InteractionCommandsService } from "./interaction-commands.js"
import { ServerIdentity, type ServerIdentityShape } from "./server-identity.js"
import { SessionCommands, type SessionCommandsService } from "./session-commands.js"
import { SessionQueries, type SessionQueriesService } from "./session-queries.js"
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
// Handler dependencies
// ============================================================================

interface ResolvedSessionServices {
  readonly registry: ExtensionRegistryService
  readonly capabilityContext?: Context.Context<never>
}

interface RpcHandlerDeps {
  readonly queries: SessionQueriesService
  readonly commands: SessionCommandsService
  readonly eventStore: EventStoreService
  readonly interactions: InteractionCommandsService
  readonly configService: ConfigServiceService
  readonly sessionRuntime: SessionRuntimeService
  readonly modelRegistry: ModelRegistryService
  readonly driverRegistry: DriverRegistryService
  readonly authStore: AuthService
  readonly authGuard: AuthGuardService
  readonly providerAuth: ProviderAuthService
  readonly extensionRegistry: ExtensionRegistryService
  readonly platform: RuntimeEnvironmentShape
  readonly sessionStorage: SessionStorageService
  readonly branchStorage: BranchStorageService
  readonly connectionTracker: ConnectionTrackerService | undefined
  readonly serverIdentity: ServerIdentityShape
  readonly resolveSessionServices: (
    sessionId: string | undefined,
  ) => Effect.Effect<ResolvedSessionServices>
  readonly resolveProfileServices: (
    cwd: string | undefined,
  ) => Effect.Effect<ResolvedSessionServices>
}

const isPublicTransportEvent = (envelope: EventEnvelope) =>
  envelope.event._tag !== "MachineTaskSucceeded" && envelope.event._tag !== "MachineTaskFailed"

const invalidateExternalDriversFor = (
  registry: DriverRegistryService,
  prev: DriverRef | undefined,
  next: DriverRef | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
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

const watchRuntimeStream = (deps: RpcHandlerDeps, { sessionId, branchId }: QueueTarget) =>
  Stream.unwrap(
    deps.sessionRuntime.watchState({ sessionId, branchId }).pipe(
      Effect.tap(() =>
        Effect.logInfo("watchRuntime.open").pipe(Effect.annotateLogs({ sessionId, branchId })),
      ),
      Effect.map((stateStream) =>
        stateStream.pipe(
          Stream.ensuring(
            Effect.logInfo("watchRuntime.close").pipe(Effect.annotateLogs({ sessionId, branchId })),
          ),
        ),
      ),
    ),
  )

// ============================================================================
// Session/branch/message/queue/interaction handlers
// ============================================================================

type SessionIdPayload = { readonly sessionId: SessionId }

const buildSessionRpcHandlers = (deps: RpcHandlerDeps) => ({
  "session.create": (input: CreateSessionInput) =>
    deps.commands
      .createSession({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.parentBranchId !== undefined ? { parentBranchId: input.parentBranchId } : {}),
        ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
        ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      })
      .pipe(
        Effect.tap((result) => WideEvent.set({ sessionId: result.sessionId })),
        withWideEvent(rpcBoundary("session.create", input.requestId)),
      ),

  "session.list": () => deps.queries.listSessions(),

  "session.get": ({ sessionId }: SessionIdPayload) => deps.queries.getSession(sessionId),

  "session.delete": ({ sessionId }: SessionIdPayload) =>
    deps.commands.deleteSession(sessionId).pipe(
      Effect.tap(() => WideEvent.set({ sessionId })),
      withWideEvent(rpcBoundary("session.delete")),
    ),

  "session.getChildren": ({ parentSessionId }: ParentSessionPayload) =>
    deps.queries.getChildSessions(parentSessionId),

  "session.getTree": ({ sessionId }: SessionIdPayload) => deps.queries.getSessionTree(sessionId),

  "session.getSnapshot": ({ sessionId, branchId }: GetSessionSnapshotInput) =>
    deps.queries.getSessionSnapshot({ sessionId, branchId }),

  "session.updateReasoningLevel": ({
    sessionId,
    reasoningLevel,
  }: UpdateSessionReasoningLevelInput) =>
    deps.commands.updateSessionReasoningLevel({ sessionId, reasoningLevel }),

  "session.events": ({ sessionId, branchId, after }: SubscribeEventsInput) =>
    deps.eventStore
      .subscribe({
        sessionId,
        ...(branchId !== undefined ? { branchId } : {}),
        ...(after !== undefined ? { after: EventId.make(after) } : {}),
      })
      .pipe(Stream.filter(isPublicTransportEvent)),

  "session.watchRuntime": (input: QueueTarget) => watchRuntimeStream(deps, input),

  "branch.list": ({ sessionId }: SessionIdPayload) => deps.queries.listBranches(sessionId),

  "branch.create": ({ sessionId, name, requestId }: CreateBranchInput) =>
    deps.commands.createBranch({
      sessionId,
      ...(name !== undefined ? { name } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    }),

  "branch.getTree": ({ sessionId }: SessionIdPayload) => deps.queries.getBranchTree(sessionId),

  "branch.switch": ({
    sessionId,
    fromBranchId,
    toBranchId,
    summarize,
    requestId,
  }: SwitchBranchInput) =>
    deps.commands.switchBranch({
      sessionId,
      fromBranchId,
      toBranchId,
      ...(summarize !== undefined ? { summarize } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    }),

  "branch.fork": ({ sessionId, fromBranchId, atMessageId, name, requestId }: ForkBranchInput) =>
    deps.commands.forkBranch({
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
    deps.commands
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

  "message.list": ({ branchId }: BranchPayload) => deps.queries.listMessages(branchId),

  "steer.command": ({ command }: { readonly command: TransportSteerCommand }) =>
    deps.commands.steer(command),

  "queue.drain": ({ sessionId, branchId, requestId }: QueueDrainInput) =>
    deps.commands.drainQueuedMessages({ sessionId, branchId, requestId }),

  "queue.get": ({ sessionId, branchId }: QueueTarget) =>
    deps.queries.getQueuedMessages({ sessionId, branchId }),

  "interaction.respondInteraction": ({
    requestId,
    sessionId,
    branchId,
    approved,
    notes,
  }: RespondInteractionInput) =>
    deps.interactions.respond({
      requestId,
      sessionId,
      branchId,
      approved,
      ...(notes !== undefined ? { notes } : {}),
    }),
})

// ============================================================================
// Config / driver / model / auth / permission handlers
// ============================================================================

const authPersistenceError = (
  action: "read" | "set" | "delete",
  provider: string,
  cause: unknown,
): ProviderAuthError =>
  new ProviderAuthError({
    message: `Failed to ${action} auth for provider "${provider}"`,
    cause,
  })

const buildConfigRpcHandlers = (deps: RpcHandlerDeps) => ({
  "permission.listRules": () => deps.configService.getPermissionRules(),

  "permission.deleteRule": ({ tool, pattern }: DeletePermissionRuleInput) =>
    deps.configService.removePermissionRule(tool, pattern),

  "model.list": () => deps.modelRegistry.list(),

  "driver.list": () =>
    Effect.gen(function* () {
      const config = yield* deps.configService.get()
      const models = yield* deps.driverRegistry.listModels()
      const externals = yield* deps.driverRegistry.listExternal()
      const agents = yield* deps.extensionRegistry.listAgents()
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
      if (driver._tag === "model" && driver.id !== undefined) {
        const found = yield* deps.driverRegistry.getModel(driver.id)
        if (found === undefined) {
          return yield* new NotFoundError({
            entity: "driver",
            message: `Unknown model driver "${driver.id}"`,
          })
        }
      }
      if (driver._tag === "external") {
        const found = yield* deps.driverRegistry.getExternal(driver.id)
        if (found === undefined) {
          return yield* new NotFoundError({
            entity: "driver",
            message: `Unknown external driver "${driver.id}"`,
          })
        }
      }

      const prevConfig = yield* deps.configService.get()
      const prevOverride = prevConfig.driverOverrides?.[agentName]
      yield* deps.configService.setDriverOverride(agentName, driver)
      yield* invalidateExternalDriversFor(deps.driverRegistry, prevOverride, driver)
    }),

  "driver.clear": ({ agentName }: ClearDriverOverrideInput) =>
    Effect.gen(function* () {
      const prevConfig = yield* deps.configService.get()
      const prevOverride = prevConfig.driverOverrides?.[agentName]
      yield* deps.configService.clearDriverOverride(agentName)
      yield* invalidateExternalDriversFor(deps.driverRegistry, prevOverride, undefined)
    }),

  "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersInput) =>
    Effect.gen(function* () {
      let cwd: string | undefined
      if (sessionId !== undefined) {
        if (deps.sessionStorage === undefined) {
          return yield* new NotFoundError({
            entity: "session",
            message: "Session not found",
          })
        }
        const session = yield* deps.sessionStorage.getSession(SessionId.make(sessionId))
        if (session === undefined) {
          return yield* new NotFoundError({
            entity: "session",
            message: "Session not found",
          })
        }
        cwd = session?.cwd
      }
      const config = yield* deps.configService.get(cwd)
      return yield* deps.authGuard
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
    deps.authStore
      .set(provider, new AuthApi({ type: "api", key }))
      .pipe(Effect.mapError((error) => authPersistenceError("set", provider, error))),

  "auth.deleteKey": ({ provider }: DeleteAuthKeyInput) =>
    deps.authStore
      .remove(provider)
      .pipe(Effect.mapError((error) => authPersistenceError("delete", provider, error))),

  "auth.listMethods": () => deps.providerAuth.listMethods(),

  "auth.authorize": ({ sessionId, provider, method }: AuthorizeAuthInput) =>
    deps.providerAuth
      .authorize(sessionId, provider, method)
      .pipe(Effect.map((result) => result ?? null)),

  "auth.callback": ({ sessionId, provider, method, authorizationId, code }: CallbackAuthInput) =>
    deps.providerAuth.callback(sessionId, provider, method, authorizationId, code),
})

// ============================================================================
// Extension transport handlers
// ============================================================================

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

const resolveExtensionSession = (
  deps: RpcHandlerDeps,
  params: {
    readonly extensionId: ExtensionId
    readonly tag: string
    readonly phase: "command" | "request"
    readonly sessionId: SessionId
    readonly branchId: BranchId
  },
): Effect.Effect<
  { readonly sessionId: SessionId; readonly branchId: BranchId; readonly session: Session },
  ExtensionProtocolError
> =>
  Effect.gen(function* () {
    const requestSessionId = params.sessionId
    const requestBranchId = params.branchId
    const session = yield* deps.sessionStorage.getSession(requestSessionId).pipe(
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

    const branch = yield* deps.branchStorage.getBranch(requestBranchId).pipe(
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

const buildExtensionRpcHandlers = (deps: RpcHandlerDeps) => ({
  "extension.listStatus": ({ sessionId }: OptionalSessionPayload) =>
    Effect.gen(function* () {
      const { registry } = yield* deps.resolveSessionServices(sessionId)
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
      const scope = yield* resolveExtensionSession(deps, {
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
      const { registry, capabilityContext } = yield* deps.resolveProfileServices(scope.session.cwd)
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
            queueFollowUp: (input) => deps.sessionRuntime.queueFollowUp(input),
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
      const request = rpcRegistry.run(extensionId, RpcId.make(capabilityId), input, hostCtx).pipe(
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
      const { registry } = yield* deps.resolveSessionServices(sessionId)
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
})

// ============================================================================
// Runtime status handlers
// ============================================================================

const buildRuntimeRpcHandlers = (deps: RpcHandlerDeps) => ({
  "runtime.status": () =>
    Effect.gen(function* () {
      const connectionCount =
        deps.connectionTracker !== undefined ? yield* deps.connectionTracker.count() : 0
      return {
        serverId: deps.serverIdentity.serverId,
        pid: deps.serverIdentity.pid,
        hostname: deps.serverIdentity.hostname,
        uptime: (yield* Clock.currentTimeMillis) - deps.serverIdentity.startedAt,
        connectionCount,
        dbPath: deps.serverIdentity.dbPath,
        buildFingerprint: deps.serverIdentity.buildFingerprint,
      }
    }),
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
    const driverRegistry = yield* DriverRegistry
    const authStore = yield* Auth
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const extensionRegistry = yield* ExtensionRegistry
    const platform = yield* RuntimeEnvironment
    const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
    const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const connectionTrackerOpt = yield* Effect.serviceOption(ConnectionTracker)
    const connectionTracker =
      connectionTrackerOpt._tag === "Some" ? connectionTrackerOpt.value : undefined
    const serverIdentity = yield* ServerIdentity

    const loadSession = (sessionId: string) =>
      sessionStorage
        .getSession(SessionId.make(sessionId))
        .pipe(Effect.orElseSucceed(() => undefined))

    const resolveProfileServices = (cwd: string | undefined) =>
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

    const resolveSessionServices = (sessionId: string | undefined) =>
      Effect.gen(function* () {
        if (sessionId === undefined) return yield* resolveProfileServices(undefined)
        const session = yield* loadSession(sessionId)
        return yield* resolveProfileServices(session?.cwd)
      })

    const deps: RpcHandlerDeps = {
      queries,
      commands,
      eventStore,
      interactions,
      configService,
      sessionRuntime,
      modelRegistry,
      driverRegistry,
      authStore,
      authGuard,
      providerAuth,
      extensionRegistry,
      platform,
      sessionStorage,
      branchStorage,
      connectionTracker,
      serverIdentity,
      resolveSessionServices,
      resolveProfileServices,
    }

    return {
      ...buildSessionRpcHandlers(deps),
      ...buildConfigRpcHandlers(deps),
      ...buildExtensionRpcHandlers(deps),
      ...buildRuntimeRpcHandlers(deps),
    }
  }),
)

export const RpcHandlersLive = Layer.merge(RpcHandlers, WorkspaceRpcMiddleware.Live)
