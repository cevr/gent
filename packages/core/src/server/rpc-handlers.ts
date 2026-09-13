import { Predicate, Clock, Effect, Layer, Option, Stream } from "effect"
import { GentRpcs } from "./rpcs"
import type { DriverRef } from "../domain/agent.js"
import { Auth, AuthApi, AuthGuard } from "../domain/auth.js"
import { ProviderAuthError } from "../domain/driver.js"
import { EventId, EventStore } from "../domain/event.js"
import { SessionId, type BranchId, type ExtensionId } from "../domain/ids.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ConfigService } from "../runtime/config-service.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import {
  ExtensionRegistry,
  listSlashCommands,
  type ExtensionRegistryService,
} from "../runtime/extensions/registry.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { makeRequestDeduper } from "../runtime/request-dedup.js"
import { SessionRuntime, type SessionRuntimeError } from "../runtime/session-runtime.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "../runtime/wide-event-boundary.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { ConnectionTracker } from "./connection-tracker.js"
import { ExtensionProtocolError, NotFoundError } from "./errors.js"
import { buildExtensionHealthSnapshot } from "./extension-health.js"
import { respondInteraction } from "./interaction-commands.js"
import { ServerIdentity } from "./server-identity.js"
import { SessionMutations } from "../domain/session-mutations.js"
import { getSessionSnapshot } from "./session-queries.js"
import { getBranchTree } from "./session-utils.js"
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

const invalidateExternalDriversFor = (
  prev: Option.Option<DriverRef>,
  next: Option.Option<DriverRef>,
) =>
  Effect.gen(function* () {
    const registry = yield* DriverRegistry
    const ids = new Set<string>()
    if (Option.isSome(prev) && prev.value._tag === "external") ids.add(prev.value.id)
    if (Option.isSome(next) && next.value._tag === "external") ids.add(next.value.id)
    for (const id of ids) {
      const driver = yield* registry.getExternal(id)
      if (!Predicate.isUndefined(driver)) yield* driver.invalidate
    }
  })

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

// ============================================================================
// RPC Handlers Layer
// ============================================================================

const RpcHandlers = GentRpcs.toLayer(
  Effect.gen(function* () {
    const mutations = yield* SessionMutations
    const eventStore = yield* EventStore
    const configService = yield* ConfigService
    const sessionRuntime = yield* SessionRuntime
    const modelRegistry = yield* ModelRegistry
    const authStore = yield* Auth
    const authGuard = yield* AuthGuard
    const providerAuth = yield* ProviderAuth
    const extensionRegistry = yield* ExtensionRegistry
    const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const messageStorage = yield* MessageStorage
    const connectionTrackerOpt = yield* Effect.serviceOption(ConnectionTracker)
    const serverIdentity = yield* ServerIdentity
    // Touching these Tags at layer-build keeps their requirements visible on the
    // RpcHandlers layer. RpcGroup.toLayer erases handler-residual R, so Tags only
    // yielded inside returned handler Effects would otherwise become deferred
    // request-time defects instead of layer-build failures.
    yield* RuntimeEnvironment
    yield* DriverRegistry

    // `message.send` has no durable operation row; the runtime keys its actor
    // command on `requestId`. This cache collapses concurrent same-requestId
    // fibers (unbounded RPC concurrency + client transport retries) so the
    // runtime sees one dispatch per request id.
    const sendMessage = yield* makeRequestDeduper<SendMessageInput, void, SessionRuntimeError>({
      body: (input) =>
        sessionRuntime
          .sendUserMessage({
            sessionId: input.sessionId,
            branchId: input.branchId,
            content: input.content,
            agentOverride: input.agentOverride,
            runSpec: input.runSpec,
            requestId: input.requestId,
          })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("session.messageSent").pipe(
                Effect.annotateLogs({
                  sessionId: input.sessionId,
                  branchId: input.branchId,
                  requestId: input.requestId,
                }),
              ),
            ),
          ),
      keyOf: (input) => Option.fromUndefinedOr(input.requestId),
    })

    const loadSession = (sessionId: string) =>
      sessionStorage.getSession(SessionId.make(sessionId)).pipe(
        Effect.map(Option.fromUndefinedOr),
        Effect.orElseSucceed(() => Option.none()),
      )

    const resolveProfileRegistry = (
      cwd: Option.Option<string>,
    ): Effect.Effect<ExtensionRegistryService> =>
      Effect.gen(function* () {
        if (Option.isNone(cwd) || Option.isNone(profileCacheOpt)) return extensionRegistry
        const profile = yield* profileCacheOpt.value.resolve(cwd.value)
        return profile.registryService
      })

    const resolveSessionRegistry = (
      sessionId: Option.Option<string>,
    ): Effect.Effect<ExtensionRegistryService> =>
      Effect.gen(function* () {
        if (Option.isNone(sessionId)) return yield* resolveProfileRegistry(Option.none())
        const session = yield* loadSession(sessionId.value)
        const cwd = Option.flatMap(session, (value) => Option.fromUndefinedOr(value.cwd))
        return yield* resolveProfileRegistry(cwd)
      })

    return {
      // ----------------------------------------------------------------------
      // Session / branch / message / queue / interaction
      // ----------------------------------------------------------------------
      "session.create": (input: CreateSessionInput) =>
        mutations
          .createSession({
            name: input.name,
            cwd: input.cwd,
            parentSessionId: input.parentSessionId,
            parentBranchId: input.parentBranchId,
            initialPrompt: input.initialPrompt,
            agentOverride: input.agentOverride,
            requestId: input.requestId,
          })
          .pipe(
            Effect.tap((result) => WideEvent.set({ sessionId: result.sessionId })),
            withWideEvent(
              WideEventBoundary.rpc("session.create", {
                requestId: input.requestId,
              }),
            ),
          ),

      "session.list": () => sessionStorage.listSessions,

      "session.get": ({ sessionId }: SessionIdPayload) =>
        sessionStorage
          .getSession(sessionId)
          .pipe(Effect.map(Option.fromUndefinedOr), Effect.map(Option.getOrNull)),

      "session.delete": ({ sessionId }: SessionIdPayload) =>
        mutations.deleteSession(sessionId).pipe(
          Effect.tap(() => WideEvent.set({ sessionId })),
          withWideEvent(WideEventBoundary.rpc("session.delete")),
        ),

      "session.getSnapshot": ({ sessionId, branchId }: GetSessionSnapshotInput) =>
        getSessionSnapshot({ sessionId, branchId }).pipe(
          Effect.tap(() => WideEvent.set({ sessionId, branchId })),
          withWideEvent(WideEventBoundary.rpc("session.getSnapshot")),
        ),

      "session.updateReasoningLevel": ({
        sessionId,
        reasoningLevel,
      }: UpdateSessionReasoningLevelInput) =>
        mutations.updateReasoningLevel({ sessionId, reasoningLevel }).pipe(
          Effect.tap(() => WideEvent.set({ sessionId, reasoningLevel })),
          withWideEvent(WideEventBoundary.rpc("session.updateReasoningLevel")),
        ),

      "session.events": ({ sessionId, branchId, after }: SubscribeEventsInput) => {
        const subscription = { sessionId, branchId, synchronize: true }
        if (!Predicate.isUndefined(after))
          Object.assign(subscription, { after: EventId.make(after) })
        return eventStore.subscribe(subscription)
      },

      "session.watchRuntime": (input: QueueTarget) => watchRuntimeStream(input),

      "branch.list": ({ sessionId }: SessionIdPayload) => branchStorage.listBranches(sessionId),

      "branch.create": ({ sessionId, name, requestId }: CreateBranchInput) =>
        mutations
          .createSessionBranch({
            sessionId,
            name,
            requestId,
          })
          .pipe(
            Effect.tap((result) => WideEvent.set({ sessionId, branchId: result.branchId })),
            withWideEvent(
              WideEventBoundary.rpc("branch.create", {
                requestId,
              }),
            ),
          ),

      "branch.getTree": ({ sessionId }: SessionIdPayload) => getBranchTree(sessionId),

      "branch.switch": ({ sessionId, fromBranchId, toBranchId, requestId }: SwitchBranchInput) =>
        mutations
          .switchActiveBranch({
            sessionId,
            fromBranchId,
            toBranchId,
            requestId,
          })
          .pipe(
            Effect.tap(() => WideEvent.set({ sessionId, fromBranchId, toBranchId })),
            withWideEvent(
              WideEventBoundary.rpc("branch.switch", {
                requestId,
              }),
            ),
          ),

      "branch.fork": ({ sessionId, fromBranchId, atMessageId, name, requestId }: ForkBranchInput) =>
        mutations
          .forkSessionBranch({
            sessionId,
            fromBranchId,
            atMessageId,
            name,
            requestId,
          })
          .pipe(
            Effect.tap((result) =>
              WideEvent.set({ sessionId, fromBranchId, branchId: result.branchId }),
            ),
            withWideEvent(
              WideEventBoundary.rpc("branch.fork", {
                requestId,
              }),
            ),
          ),

      "message.send": ({
        sessionId,
        branchId,
        content,
        agentOverride,
        runSpec,
        requestId,
      }: SendMessageInput) =>
        sendMessage({
          sessionId,
          branchId,
          content,
          agentOverride,
          runSpec,
          requestId,
        }).pipe(
          Effect.tap(() => WideEvent.set({ sessionId, branchId })),
          withWideEvent(
            WideEventBoundary.rpc("message.send", {
              requestId,
            }),
          ),
        ),

      "message.list": ({ branchId }: BranchPayload) => messageStorage.listMessages(branchId),

      "steer.command": ({ command }: { readonly command: TransportSteerCommand }) =>
        sessionRuntime.steer(command).pipe(
          Effect.tap(() =>
            WideEvent.set({
              sessionId: command.sessionId,
              branchId: command.branchId,
              steerTag: command._tag,
            }),
          ),
          withWideEvent(WideEventBoundary.rpc("steer.command")),
        ),

      "queue.drain": ({ sessionId, branchId, requestId }: QueueDrainInput) =>
        sessionRuntime.drainQueuedMessages({ sessionId, branchId, requestId }).pipe(
          Effect.withSpan("SessionRuntime.drainQueuedMessages"),
          Effect.tap(() => WideEvent.set({ sessionId, branchId })),
          withWideEvent(
            WideEventBoundary.rpc("queue.drain", {
              requestId,
            }),
          ),
        ),

      "queue.get": ({ sessionId, branchId }: QueueTarget) =>
        sessionRuntime.getQueuedMessages({ sessionId, branchId }).pipe(
          Effect.withSpan("SessionQueries.getQueuedMessages"),
          Effect.tap(() => WideEvent.set({ sessionId, branchId })),
          withWideEvent(WideEventBoundary.rpc("queue.get")),
        ),

      "interaction.respondInteraction": (input: RespondInteractionInput) =>
        respondInteraction(input).pipe(
          Effect.tap(() =>
            WideEvent.set({
              sessionId: input.sessionId,
              branchId: input.branchId,
              requestId: input.requestId,
              approved: input.approved,
            }),
          ),
          withWideEvent(WideEventBoundary.rpc("interaction.respondInteraction")),
        ),

      // ----------------------------------------------------------------------
      // Config / driver / model / auth / permission
      // ----------------------------------------------------------------------
      "permission.listRules": () =>
        configService
          .get()
          .pipe(
            Effect.map((c) => Option.getOrElse(Option.fromUndefinedOr(c.permissions), () => [])),
          ),

      "permission.deleteRule": ({ tool, pattern }: DeletePermissionRuleInput) =>
        configService.removePermissionRule(tool, pattern),

      "model.list": () => modelRegistry.list,

      "driver.list": () =>
        Effect.gen(function* () {
          const config = yield* configService.get()
          const driverRegistry = yield* DriverRegistry
          const models = yield* driverRegistry.listModels
          const externals = yield* driverRegistry.listExternal
          const agents = [...extensionRegistry.getResolved().agents.values()]
          const drivers = [
            ...models.map((driver) =>
              DriverInfo.cases.model.make({
                id: driver.id,
                description: driver.name,
              }),
            ),
            ...externals.map((driver) =>
              DriverInfo.cases.external.make({
                id: driver.id,
              }),
            ),
          ]
          const overrides = Option.getOrElse(
            Option.fromUndefinedOr(config.driverOverrides),
            () => ({}),
          )
          return new DriverListResult({
            drivers,
            overrides,
            agents,
          })
        }),

      "driver.set": ({ agentName, driver }: SetDriverOverrideInput) =>
        Effect.gen(function* () {
          const driverRegistry = yield* DriverRegistry
          if (driver._tag === "model" && !Predicate.isUndefined(driver.id)) {
            const found = yield* driverRegistry.getModel(driver.id)
            if (Predicate.isUndefined(found)) {
              return yield* new NotFoundError({
                message: `Unknown model driver "${driver.id}"`,
              })
            }
          }
          if (driver._tag === "external") {
            const found = yield* driverRegistry.getExternal(driver.id)
            if (Predicate.isUndefined(found)) {
              return yield* new NotFoundError({
                message: `Unknown external driver "${driver.id}"`,
              })
            }
          }

          const prevConfig = yield* configService.get()
          const prevOverride = prevConfig.driverOverrides?.[agentName]
          yield* configService.setDriverOverride(agentName, driver)
          yield* invalidateExternalDriversFor(
            Option.fromUndefinedOr(prevOverride),
            Option.some(driver),
          )
        }),

      "driver.clear": ({ agentName }: ClearDriverOverrideInput) =>
        Effect.gen(function* () {
          const prevConfig = yield* configService.get()
          const prevOverride = prevConfig.driverOverrides?.[agentName]
          yield* configService.clearDriverOverride(agentName)
          yield* invalidateExternalDriversFor(Option.fromUndefinedOr(prevOverride), Option.none())
        }),

      "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersInput) =>
        Effect.gen(function* () {
          let cwd = Option.none<string>()
          if (!Predicate.isUndefined(sessionId)) {
            const session = yield* sessionStorage.getSession(SessionId.make(sessionId))
            if (Predicate.isUndefined(session)) {
              return yield* new NotFoundError({
                message: "Session not found",
              })
            }
            cwd = Option.fromUndefinedOr(session.cwd)
          }
          const config = yield* configService.get(Option.getOrUndefined(cwd))
          const providerScope = {
            agentName,
            sessionId,
            driverOverrides: config.driverOverrides,
          }
          return yield* authGuard
            .listProviders(providerScope)
            .pipe(Effect.mapError((error) => authPersistenceError("read", "*", error)))
        }),

      "auth.setKey": ({ provider, key }: SetAuthKeyInput) =>
        authStore
          .set(provider, AuthApi.make({ type: "api", key }))
          .pipe(Effect.mapError((error) => authPersistenceError("set", provider, error))),

      "auth.deleteKey": ({ provider }: DeleteAuthKeyInput) =>
        authStore
          .remove(provider)
          .pipe(Effect.mapError((error) => authPersistenceError("delete", provider, error))),

      "auth.listMethods": () => providerAuth.listMethods,

      "auth.authorize": ({ sessionId, provider, method }: AuthorizeAuthInput) =>
        providerAuth.authorize(sessionId, provider, method).pipe(Effect.map(Option.getOrNull)),

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
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          const activationStatuses = registry.getResolved().extensionStatuses
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
          yield* WideEvent.set({
            sessionId,
            branchId,
            extensionId,
            capabilityId,
          })
          return yield* sessionRuntime
            .requestExtension({
              sessionId,
              branchId,
              extensionId,
              capabilityId,
              input,
            })
            .pipe(
              Effect.mapError((error) =>
                extensionRequestError({
                  extensionId,
                  capabilityId,
                  message: error.message,
                }),
              ),
            )
        }).pipe(withWideEvent(WideEventBoundary.rpc("extension.request"))),

      "extension.listSlashCommands": ({ sessionId }: SessionIdPayload) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
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
          let connectionCount = 0
          if (Option.isSome(connectionTrackerOpt)) {
            connectionCount = yield* connectionTrackerOpt.value.count
          }
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
