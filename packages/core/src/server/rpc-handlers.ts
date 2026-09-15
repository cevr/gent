import { Predicate, Clock, Effect, Layer, Option, Stream } from "effect"
import { GentRpcs } from "./rpcs"
import type { DriverRef } from "../domain/agent.js"
import { Auth, AuthApi, AuthGuard } from "../domain/auth.js"
import { ProviderAuthError } from "../domain/driver.js"
import { EventId, EventStore, InteractionResolved } from "../domain/event.js"
import { SessionId, type BranchId, type RequestId } from "../domain/ids.js"
import { ProviderAuth } from "../providers/provider-auth.js"
import { ConfigService } from "../runtime/config-service.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../runtime/extensions/registry.js"
import { ModelRegistry } from "../runtime/model-registry.js"
import { RuntimeEnvironment } from "../runtime/runtime-environment.js"
import { makeRequestDeduper } from "../runtime/request-dedup.js"
import { SessionRuntime, type SessionRuntimeError } from "../runtime/session-runtime.js"
import { SessionProfileCache } from "../runtime/session-profile.js"
import { applyAgentOverrides, resolveSessionSettings } from "../runtime/agent/turn-resolve.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "../runtime/wide-event-boundary.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import { makeStorageTransaction } from "../storage/sqlite-storage.js"
import {
  projectMessagesWithToolInteractions,
  toolCallDurations,
} from "../domain/message-part-display.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { InteractionRequestMismatchError } from "../domain/interaction-request.js"
import { omitUndefined } from "../domain/guards.js"
import { ApprovalService } from "../runtime/approval-service.js"
import { resolveExistingSessionBranch } from "../runtime/session-runtime-context.js"
import { MessageStorage } from "../storage/message-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { ConnectionTracker } from "./connection-tracker.js"
import { ExtensionProtocolError, InvalidStateError, NotFoundError } from "./errors.js"
import { buildExtensionHealthSnapshot } from "./extension-health.js"
import { ServerIdentity } from "./server-identity.js"
import { SessionMutations } from "../domain/session-mutations.js"
import { getBranchTree } from "./session-utils.js"
import { WorkspaceRpcMiddleware } from "./workspace-rpc.js"
import {
  DriverInfo,
  DriverListResult,
  SessionSnapshot,
  SlashCommandInfo,
  type AuthorizeAuthInput,
  type CallbackAuthInput,
  type ClearDriverOverrideInput,
  type CreateBranchInput,
  type CreateSessionInput,
  type DeleteAuthKeyInput,
  type ExtensionRpcRequestInput,
  type ForkBranchInput,
  type GetSessionSnapshotInput,
  type ListAuthProvidersPayload,
  type QueueDrainInput,
  type QueueTarget,
  type RespondInteractionInput,
  type SendMessageInput,
  type SetAuthKeyInput,
  type SetDriverOverrideInput,
  type SteerCommand as TransportSteerCommand,
  type SubscribeEventsInput,
  type SwitchBranchInput,
  type UpdateSessionSettingsInput,
} from "./transport-contract.js"

/** The registry serving a cwd: its profile's when a profile cache is wired, else the launch registry. */
const resolveRegistryForCwd = Effect.fn("SessionQueries.resolveRegistryForCwd")(function* (
  cwd: Option.Option<string>,
) {
  const extensionRegistry = yield* ExtensionRegistry
  const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
  if (Option.isNone(cwd) || Option.isNone(profileCacheOpt)) return extensionRegistry
  const profile = yield* profileCacheOpt.value.resolve(cwd.value)
  return profile.registryService
})

/** The one read the client hydrates from: persisted conversation plus live runtime state. */
export const getSessionSnapshot = Effect.fn("SessionQueries.getSessionSnapshot")(function* (
  input: GetSessionSnapshotInput,
) {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const eventStorage = yield* EventStorage
  const storageTransaction = yield* makeStorageTransaction
  const sessionRuntime = yield* SessionRuntime
  const session = yield* sessionStorage.getSession(input.sessionId)
  if (Predicate.isUndefined(session)) {
    return yield* new NotFoundError({ message: "Session not found" })
  }
  const branch = yield* branchStorage.getBranch(input.branchId)
  if (Predicate.isUndefined(branch) || branch.sessionId !== input.sessionId) {
    return yield* new NotFoundError({ message: "Branch not found" })
  }

  const snapshotState = yield* storageTransaction(
    Effect.gen(function* () {
      const messages = yield* messageStorage.listMessages(input.branchId)
      const events = yield* eventStorage
        .listEvents({ sessionId: input.sessionId, branchId: input.branchId })
        .pipe(
          Effect.catchTag(
            "EventDecodeError",
            (cause) =>
              new InvalidStateError({ message: `Failed to read session events: ${cause.message}` }),
          ),
        )
      const lastEventId = yield* eventStorage.getLatestEventId({
        sessionId: input.sessionId,
        branchId: input.branchId,
      })
      return {
        projectedMessages: projectMessagesWithToolInteractions(messages, toolCallDurations(events)),
        lastEventId,
      }
    }),
  )

  const runtime = yield* sessionRuntime.getState(input).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidStateError({
          message: `Failed to read session runtime state: ${cause.message}`,
        }),
    ),
  )

  // The footer shows what the next turn would use; resolving it here keeps
  // the precedence (session > config > agent) in one place with the turn.
  const registry = yield* resolveRegistryForCwd(Option.fromUndefinedOr(session.cwd))
  const configService = yield* ConfigService
  const config = yield* configService.get(session.cwd)
  const agent = Option.fromUndefinedOr(
    [...registry.getResolved().agents.values()].find((entry) => entry.name === runtime.agent),
  )
  const settings = resolveSessionSettings(
    Option.map(agent, (definition) =>
      applyAgentOverrides(definition, Option.fromUndefinedOr(config.agents?.[definition.name])),
    ),
    session,
  )

  // Cumulative metrics (turns, cost, last-model) are the authority for
  // client HUD displays. Keeping them on the snapshot means the TUI
  // hydrates cost/tokens from here instead of re-deriving by joining
  // streamed events against a client-side model registry.
  const metrics = yield* sessionRuntime
    .getMetrics({ sessionId: input.sessionId, branchId: input.branchId })
    .pipe(
      Effect.catchEager(() =>
        Effect.succeed({
          turns: 0,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        }),
      ),
    )

  // Extension state is no longer hydrated through the session snapshot —
  // clients call the extension's typed `client.extension.request(...)` on
  // mount and subscribe to `ExtensionStateChanged` events for refetch
  // signals. The privileged out-of-band UI snapshot channel is gone.

  return new SessionSnapshot({
    sessionId: input.sessionId,
    branchId: input.branchId,
    name: session.name,
    messages: snapshotState.projectedMessages,
    lastEventId: Option.getOrNull(Option.fromUndefinedOr(snapshotState.lastEventId)),
    modelId: session.modelId,
    reasoningLevel: session.reasoningLevel,
    resolvedModelId: settings.modelId,
    resolvedReasoningLevel: Option.getOrUndefined(settings.reasoningLevel),
    activeBranchId: session.activeBranchId,
    runtime,
    metrics,
  })
})

/** Resolve the pending interaction on a branch and wake its loop. */
const respondInteraction = Effect.fn("InteractionCommands.respond")(function* (
  input: RespondInteractionInput,
) {
  const approvalService = yield* ApprovalService
  const sessionRuntime = yield* SessionRuntime
  const eventPublisher = yield* EventPublisher
  yield* resolveExistingSessionBranch({
    sessionId: input.sessionId,
    branchId: input.branchId,
  })

  const pendingRequestId = yield* approvalService.pendingRequestId(input)
  if (pendingRequestId !== input.requestId) {
    let message = "Interaction response requestId does not match the pending request"
    if (Predicate.isUndefined(pendingRequestId)) {
      message = "No pending interaction request exists for this session branch"
    }
    return yield* new InteractionRequestMismatchError({
      message,
      expectedRequestId: pendingRequestId,
      actualRequestId: input.requestId,
      sessionId: input.sessionId,
      branchId: input.branchId,
    })
  }

  const decision = {
    approved: input.approved,
    notes: input.notes,
    ...omitUndefined({ editedContent: input.editedContent }),
  }
  // 1. Store resolution durably so re-entering present() finds it
  yield* approvalService.storeResolution(input.requestId, decision)
  // 2. Wake the machine. present() marks the row resolved only when the
  //    tool consumes the durable decision.
  yield* sessionRuntime.respondInteraction({
    sessionId: input.sessionId,
    branchId: input.branchId,
    requestId: input.requestId,
  })
  // 3. Publish resolution event
  yield* eventPublisher
    .publish(
      InteractionResolved.make({
        sessionId: input.sessionId,
        branchId: input.branchId,
        requestId: input.requestId,
        ...decision,
      }),
    )
    .pipe(Effect.catchEager(() => Effect.void))
})

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

/** Run one RPC inside its wide-event boundary and record the fields its result names. */
const rpc = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  fields: (result: A) => Parameters<typeof WideEvent.set>[0],
  requestId?: RequestId,
) =>
  effect.pipe(
    Effect.tap((result) => WideEvent.set(fields(result))),
    withWideEvent(WideEventBoundary.rpc(method, { requestId })),
  )

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

    const resolveSessionRegistry = (
      sessionId: Option.Option<string>,
    ): Effect.Effect<ExtensionRegistryService> =>
      Effect.gen(function* () {
        if (Option.isNone(sessionId)) return yield* resolveRegistryForCwd(Option.none())
        const session = yield* loadSession(sessionId.value)
        const cwd = Option.flatMap(session, (value) => Option.fromUndefinedOr(value.cwd))
        return yield* resolveRegistryForCwd(cwd)
      }).pipe(Effect.provideService(ExtensionRegistry, extensionRegistry))

    return {
      // ----------------------------------------------------------------------
      // Session / branch / message / queue / interaction
      // ----------------------------------------------------------------------
      "session.create": (input: CreateSessionInput) =>
        rpc(
          "session.create",
          mutations.createSession(input),
          (result) => ({ sessionId: result.sessionId }),
          input.requestId,
        ),

      "session.list": () => sessionStorage.listSessions,

      "session.get": ({ sessionId }: SessionIdPayload) =>
        sessionStorage
          .getSession(sessionId)
          .pipe(Effect.map(Option.fromUndefinedOr), Effect.map(Option.getOrNull)),

      "session.delete": ({ sessionId }: SessionIdPayload) =>
        rpc("session.delete", mutations.deleteSession(sessionId), () => ({ sessionId })),

      "session.getSnapshot": (input: GetSessionSnapshotInput) =>
        rpc("session.getSnapshot", getSessionSnapshot(input), () => input),

      "session.updateSettings": (input: UpdateSessionSettingsInput) =>
        rpc("session.updateSettings", mutations.updateSettings(input), () => input),

      "session.events": ({ sessionId, branchId, after }: SubscribeEventsInput) => {
        const subscription = { sessionId, branchId, synchronize: true }
        if (!Predicate.isUndefined(after))
          Object.assign(subscription, { after: EventId.make(after) })
        return eventStore.subscribe(subscription)
      },

      "session.watchRuntime": (input: QueueTarget) => watchRuntimeStream(input),

      "branch.list": ({ sessionId }: SessionIdPayload) => branchStorage.listBranches(sessionId),

      "branch.create": (input: CreateBranchInput) =>
        rpc(
          "branch.create",
          mutations.createSessionBranch(input),
          (result) => ({ sessionId: input.sessionId, branchId: result.branchId }),
          input.requestId,
        ),

      "branch.getTree": ({ sessionId }: SessionIdPayload) => getBranchTree(sessionId),

      "branch.switch": (input: SwitchBranchInput) =>
        rpc(
          "branch.switch",
          mutations.switchActiveBranch(input),
          () => ({
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            toBranchId: input.toBranchId,
          }),
          input.requestId,
        ),

      "branch.fork": (input: ForkBranchInput) =>
        rpc(
          "branch.fork",
          mutations.forkSessionBranch(input),
          (result) => ({
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            branchId: result.branchId,
          }),
          input.requestId,
        ),

      "message.send": (input: SendMessageInput) =>
        rpc(
          "message.send",
          sendMessage(input),
          () => ({ sessionId: input.sessionId, branchId: input.branchId }),
          input.requestId,
        ),

      "message.list": ({ branchId }: BranchPayload) => messageStorage.listMessages(branchId),

      "steer.command": ({ command }: { readonly command: TransportSteerCommand }) =>
        rpc("steer.command", sessionRuntime.steer(command), () => ({
          sessionId: command.sessionId,
          branchId: command.branchId,
          steerTag: command._tag,
        })),

      "queue.drain": ({ sessionId, branchId, requestId }: QueueDrainInput) =>
        rpc(
          "queue.drain",
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId, requestId })
            .pipe(Effect.withSpan("SessionRuntime.drainQueuedMessages")),
          () => ({ sessionId, branchId }),
          requestId,
        ),

      "queue.get": (input: QueueTarget) =>
        rpc(
          "queue.get",
          sessionRuntime
            .getQueuedMessages(input)
            .pipe(Effect.withSpan("SessionQueries.getQueuedMessages")),
          () => input,
        ),

      "interaction.respondInteraction": (input: RespondInteractionInput) =>
        rpc("interaction.respondInteraction", respondInteraction(input), () => ({
          sessionId: input.sessionId,
          branchId: input.branchId,
          requestId: input.requestId,
          approved: input.approved,
        })),

      // ----------------------------------------------------------------------
      // Config / driver / model / auth
      // ----------------------------------------------------------------------
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

      "auth.listProviders": ({ agentName, sessionId }: ListAuthProvidersPayload) =>
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
              Effect.mapError(
                (error) =>
                  new ExtensionProtocolError({
                    extensionId,
                    tag: capabilityId,
                    message: error.message,
                  }),
              ),
            )
        }).pipe(withWideEvent(WideEventBoundary.rpc("extension.request"))),

      "extension.listSlashCommands": ({ sessionId }: SessionIdPayload) =>
        Effect.gen(function* () {
          const registry = yield* resolveSessionRegistry(Option.fromUndefinedOr(sessionId))
          return registry.getResolved().slashCommands.map(
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
