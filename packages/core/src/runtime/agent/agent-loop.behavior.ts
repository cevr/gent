/**
 * Per-(sessionId, branchId) loop behavior factory.
 *
 * Built by the `AgentLoop` actor for each (sessionId, branchId). Same turn
 * flow as the public `SessionRuntime` boundary, with recursive follow-up
 * queueing supplied as an explicit callback.
 *
 * @module
 */

import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Ref,
  Schema,
  Semaphore,
  Scope,
  TxQueue,
  TxSubscriptionRef,
  type Stream,
} from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  AgentName,
  DEFAULT_AGENT_NAME,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import {
  AgentSwitched,
  ErrorOccurred,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
  type AgentEvent,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type { MessageMetadata } from "../../domain/message.js"
import { InteractionRequestId, type BranchId, type SessionId } from "../../domain/ids.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { makeAmbientExtensionHostContextDeps } from "../make-extension-host-context.js"
import { ConfigService } from "../config-service.js"
import { DEFAULTS } from "../../domain/defaults.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { StorageError } from "../../domain/storage-error.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import { SessionProfileCache } from "../session-profile.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "../extensions/driver-registry.js"
import { makeExtensionHostPlatform } from "../extensions/host-platform.js"
import { ToolRunner } from "./tool-runner.js"
import { ModelRegistry } from "../model-registry.js"
import type { GentPlatform } from "../gent-platform.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { AllowAllPermission, resolveSessionEnvironment } from "../session-runtime-context.js"
import {
  buildIdleState,
  buildRunningState,
  clearInFlightQueuedTurn,
  drainVisibleQueueItems,
  emptyLoopQueueState,
  takeNextQueuedTurn,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  buildInitialAgentLoopState,
  appendFollowUpQueueState,
  appendSteeringItem,
  countQueuedFollowUps,
  projectRuntimeState,
  AgentLoopError,
  queueSnapshotFromQueueState,
  type AgentLoopState,
  type LoopQueueState,
  type LoopState,
  type QueuedTurnItem,
  type RunningState,
  type SessionRuntimeState,
} from "./agent-loop.state.js"
import type { QueueSnapshot } from "../../domain/queue.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import {
  collectExternalTurnResponse,
  collectModelTurnResponse,
  emptyTurnMetrics,
  makeActiveStreamHandle,
  signalActiveStreamInterrupt,
  type ActiveStreamHandle,
} from "./turn-response.js"
import {
  ToolInteractionPending,
  computeStreamEndedCost,
  executeToolCalls,
  findPersistedEvent,
  persistAssistantParts,
  persistMessageReceived,
  persistToolParts,
  resolveTurnContext,
  resolveTurnSource,
  toolCallsFromResponseParts,
  type AssistantResponsePart,
  type PricingLookup,
  type ResolvedTurnContext,
  type ToolResponsePart,
} from "./turn-helpers.js"

export const resolveStoredAgent = (params: {
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<AgentNameType, never, EventStorage> =>
  Effect.gen(function* () {
    const eventStorage = yield* EventStorage
    const latestAgentEvent = yield* eventStorage
      .getLatestEvent({
        sessionId: params.sessionId,
        branchId: params.branchId,
        tags: ["AgentSwitched"],
      })
      .pipe(Effect.catchEager(() => Effect.void))

    const raw =
      latestAgentEvent !== undefined && latestAgentEvent._tag === "AgentSwitched"
        ? latestAgentEvent.toAgent
        : undefined

    return Schema.is(AgentName)(raw) ? raw : DEFAULT_AGENT_NAME
  })

export type AgentLoopBehavior = {
  persistenceFailure: Effect.Effect<void, AgentLoopError>
  readState: Effect.Effect<AgentLoopState>
  stateChanges: Stream.Stream<AgentLoopState>
  runtimeState: Effect.Effect<SessionRuntimeState>
  queueSnapshot: Effect.Effect<QueueSnapshot>
  setStartingState: (state: RunningState) => Effect.Effect<void>
  reserveStartOrQueueFollowUp: (
    item: QueuedTurnItem,
    options: { readonly coldQueueOnly: boolean },
  ) => Effect.Effect<RunningState | undefined, AgentLoopError>
  reserveRunStartOrQueueFollowUp: (item: QueuedTurnItem) => Effect.Effect<
    | {
        readonly stateEpochBaseline: number
        readonly turnFailureBaseline: number
      }
    | undefined,
    AgentLoopError
  >
  takeNextQueuedTurnIfIdle: Effect.Effect<QueuedTurnItem | undefined, AgentLoopError>
  takeNextQueuedTurn: Effect.Effect<QueuedTurnItem | undefined, AgentLoopError>
  appendSteering: (item: QueuedTurnItem) => Effect.Effect<LoopState, AgentLoopError>
  drainQueue: Effect.Effect<QueueSnapshot, AgentLoopError>
  resolveTurnProfile: Effect.Effect<{
    turnExtensionRegistry: ExtensionRegistryService
    turnDriverRegistry: DriverRegistryService
    turnPermission: PermissionService
    turnBaseSections: ReadonlyArray<PromptSection>
    turnHostCtx: ExtensionHostContext
  }>
  persistState: (state: LoopState) => Effect.Effect<void, AgentLoopError>
  refreshRuntimeState: Effect.Effect<void, AgentLoopError>
  /** Read the current FSM state. Replaces effect-machine `actor.snapshot`. */
  snapshot: Effect.Effect<LoopState>
  startTurn: (item: QueuedTurnItem) => Effect.Effect<void, AgentLoopError>
  interruptActiveStream: Effect.Effect<void>
  interrupt: Effect.Effect<void, AgentLoopError>
  switchAgent: (agent: AgentNameType) => Effect.Effect<void, AgentLoopError>
  respondInteraction: (requestId: InteractionRequestId) => Effect.Effect<void, AgentLoopError>
  withSideMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Mark the per-entity behavior ready to accept state mutations. */
  start: Effect.Effect<void, AgentLoopError>
  /** Resolves once the loop scope is closed. */
  awaitExit: Effect.Effect<void>
  close: Effect.Effect<void>
}

export const interruptActiveStream = (
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const activeStream = yield* Ref.get(activeStreamRef)
    if (activeStream === undefined) return
    yield* signalActiveStreamInterrupt(activeStream)
  })

const publishPhaseFailure = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  cause: Cause.Cause<unknown>
}) =>
  params
    .publishEvent(
      ErrorOccurred.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        error: Cause.pretty(params.cause),
      }),
    )
    .pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("failed to publish ErrorOccurred").pipe(
          Effect.annotateLogs({ error: String(error) }),
        ),
      ),
      Effect.asVoid,
    )

export const causeToAgentLoopError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return Schema.is(AgentLoopError)(error)
    ? error
    : new AgentLoopError({
        message: "Agent loop turn failed",
        cause: error,
      })
}

/**
 * Closure-local follow-up enqueue. Stand-in for the legacy
 * `service.queueFollowUp` recursive reference; routes back through the actor
 * via mutual recursion with `Message` as the authoritative payload.
 */
export type EnqueueFollowUp = (input: {
  sessionId: SessionId
  branchId: BranchId
  content: string
  metadata?: MessageMetadata
}) => Effect.Effect<void, AgentLoopError | StorageError>

/**
 * Per-(sessionId, branchId) loop behavior factory.
 *
 * Yields layer-level services directly inside its Effect body — the actor
 * does not pre-bundle them into a deps record. The factory returns
 * `Effect<AgentLoopBehavior, never, R>` whose R-channel is the full union of
 * services consumed by the loop, propagating cleanly to the actor layer.
 */
export const makeAgentLoopBehavior = (
  sessionId: SessionId,
  branchId: BranchId,
  sideMutationSemaphore: Semaphore.Semaphore,
  baseSections: ReadonlyArray<PromptSection>,
  enqueueFollowUp: EnqueueFollowUp,
  initialQueue: LoopQueueState = emptyLoopQueueState(),
): Effect.Effect<
  AgentLoopBehavior,
  never,
  | SessionStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | EventStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ExtensionRegistry
  | DriverRegistry
  | EventPublisher
  | ToolRunner
  | ConfigService
  | ModelRegistry
  | ChildProcessSpawner
  | GentPlatform
> =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const queueStorage = yield* AgentLoopQueueStorage
    yield* ModelResolver
    const extensionRegistry = yield* ExtensionRegistry
    const driverRegistry = yield* DriverRegistry
    const eventPublisher = yield* EventPublisher
    yield* ToolRunner
    const configServiceForRun = yield* ConfigService
    const modelRegistryForRun = yield* ModelRegistry
    const host = yield* makeExtensionHostPlatform
    const storageTransaction = yield* makeStorageTransaction
    // Snapshot the layer-build context so behavior methods (declared as
    // `Effect<A, E, never>` in `AgentLoopBehavior`) can resolve Tags that
    // turn-helpers now yield inside (post-W33-C3.3). Without this, helper
    // requirements like `MessageStorage`, `EventPublisher`, `SqlClient`,
    // `ModelResolver`, `ToolRunner`, etc. leak into the method R-channels
    // and break the interface.
    const runtimeContext = yield* Effect.context<
      | SessionStorage
      | MessageStorage
      | EventStorage
      | SqlClient.SqlClient
      | ModelResolver
      | ToolRunner
      | EventPublisher
    >()
    const provideRuntime = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<
      A,
      E,
      Exclude<
        R,
        | SessionStorage
        | MessageStorage
        | EventStorage
        | SqlClient.SqlClient
        | ModelResolver
        | ToolRunner
        | EventPublisher
      >
    > => Effect.provideContext(effect, runtimeContext)
    const getPricing: PricingLookup = (modelId) =>
      modelRegistryForRun.list().pipe(
        Effect.map((models) => models.find((m) => m.id === modelId)?.pricing),
        Effect.catchEager(() =>
          Effect.sync(
            (): { readonly input: number; readonly output: number } | undefined => undefined,
          ),
        ),
      )

    const publishEvent = (event: AgentEvent) =>
      eventPublisher.publish(event).pipe(
        Effect.mapError(
          (error) =>
            new AgentLoopError({
              message: `Failed to publish ${event._tag}`,
              cause: error,
            }),
        ),
      )
    const publishEventOrDie = (event: AgentEvent) => publishEvent(event).pipe(Effect.orDie)

    const sessionProfileCache = yield* Effect.serviceOption(SessionProfileCache)
    const permissionService = yield* Effect.serviceOption(Permission)

    const hostDeps = yield* makeAmbientExtensionHostContextDeps({
      extensionRegistry,
      overrides: {
        host,
        sessionControl: {
          queueFollowUp: (input): Effect.Effect<void, AgentLoopError | StorageError> =>
            enqueueFollowUp(input),
        },
      },
    })

    const profileCache = sessionProfileCache._tag === "Some" ? sessionProfileCache.value : undefined
    const defaultPermission =
      permissionService._tag === "Some" ? permissionService.value : AllowAllPermission

    const resolveTurnProfile = provideRuntime(
      resolveSessionEnvironment({
        sessionId,
        branchId,
        hostDeps,
        profileCache,
        defaults: {
          driverRegistry,
          permission: defaultPermission,
          baseSections,
        },
      }),
    ).pipe(
      Effect.map(({ environment }) => ({
        turnExtensionRegistry: environment.extensionRegistry,
        turnDriverRegistry: environment.driverRegistry,
        turnPermission: environment.permission,
        turnBaseSections: environment.baseSections,
        turnHostCtx: environment.hostCtx,
      })),
    )

    const loopScope = yield* Scope.make()
    const turnWorkerQueue = yield* TxQueue.unbounded<RunningState>()
    const activeStreamRef = yield* Ref.make<ActiveStreamHandle | undefined>(undefined)
    const turnMetricsRef = yield* Ref.make(emptyTurnMetrics())
    const interruptedRef = yield* Ref.make(false)
    const currentAgent = yield* resolveStoredAgent({
      sessionId,
      branchId,
    })
    const initialLoopState = buildIdleState({ currentAgent })
    const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
      buildInitialAgentLoopState({ state: initialLoopState, queue: initialQueue }),
    )
    const queuePersistenceSemaphore = yield* Semaphore.make(1)
    const persistenceFailure = yield* Deferred.make<void, AgentLoopError>()
    const closed = yield* Deferred.make<void>()
    const startedRef = yield* Ref.make(false)

    const persistCommittedQueue = (queue: LoopQueueState, operation: string) =>
      Effect.flatMap(Ref.get(startedRef), (started) =>
        started
          ? queueStorage.putQueueState(sessionId, branchId, queue).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentLoopError({
                    message: `Failed to persist ${operation} for ${sessionId}/${branchId}`,
                    cause,
                  }),
              ),
            )
          : Effect.void,
      )

    const recordPersistenceFailure = (error: AgentLoopError) =>
      Deferred.fail(persistenceFailure, error).pipe(Effect.catchEager(() => Effect.void))

    const mergeConcurrentLoopMetadata = (
      base: AgentLoopState,
      current: AgentLoopState,
      next: AgentLoopState,
    ): AgentLoopState => ({
      ...next,
      turnFailure:
        current.turnFailure !== base.turnFailure ? current.turnFailure : next.turnFailure,
    })

    const commitQueueTransaction = <A>(
      operation: string,
      decide: (state: AgentLoopState) => {
        readonly value: A
        readonly next: AgentLoopState
        readonly persist: boolean
      },
    ): Effect.Effect<A, AgentLoopError> =>
      queuePersistenceSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const base = yield* TxSubscriptionRef.get(loopRef)
          const next = decide(base)
          const committed = next.persist
            ? {
                ...next.next,
                stateEpoch: next.next.stateEpoch + 1,
              }
            : next.next
          const decision = { ...next, next: committed }
          if (decision.persist) {
            yield* persistCommittedQueue(decision.next.queue, operation).pipe(
              Effect.tapError(recordPersistenceFailure),
            )
          }
          yield* TxSubscriptionRef.update(loopRef, (current) =>
            mergeConcurrentLoopMetadata(base, current, decision.next),
          )
          return decision.value
        }),
      )

    const persistRuntimeState = (state: LoopState) =>
      queuePersistenceSemaphore.withPermits(1)(
        TxSubscriptionRef.get(loopRef).pipe(
          Effect.flatMap((s) =>
            queueStorage.putQueueState(sessionId, branchId, s.queue).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentLoopError({
                    message: `Failed to persist loop queue for ${sessionId}/${branchId}`,
                    cause,
                  }),
              ),
              Effect.andThen(
                TxSubscriptionRef.update(loopRef, (current) => ({
                  ...current,
                  state,
                  queue: current.queue,
                  stateEpoch: current.stateEpoch + 1,
                  startingState: undefined,
                })),
              ),
            ),
          ),
        ),
      )

    const recordTurnFailure = (cause: Cause.Cause<unknown>) =>
      TxSubscriptionRef.update(loopRef, (s) => ({
        ...s,
        turnFailure: {
          epoch: (s.turnFailure?.epoch ?? 0) + 1,
          error: causeToAgentLoopError(cause),
        },
      }))

    const currentLoopState = TxSubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.state))
    const readState = TxSubscriptionRef.get(loopRef)
    const stateChanges = TxSubscriptionRef.changesStream(loopRef)
    const runtimeState = readState.pipe(Effect.map(projectRuntimeState))
    const queueState = readState.pipe(Effect.map((s) => s.queue))
    const queueSnapshot = queueState.pipe(Effect.map(queueSnapshotFromQueueState))
    const setStartingState = (state: RunningState) =>
      TxSubscriptionRef.update(loopRef, (s) => ({
        ...s,
        startingState: state,
      }))
    const reserveStartOrQueueFollowUp = (
      item: QueuedTurnItem,
      options: { readonly coldQueueOnly: boolean },
    ) =>
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis
        return yield* commitQueueTransaction<RunningState | undefined | AgentLoopError>(
          "reserved or queued follow-up",
          (current) => {
            if (countQueuedFollowUps(current.queue) >= DEFAULTS.followUpQueueMax) {
              return {
                value: new AgentLoopError({
                  message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                }),
                next: current,
                persist: false,
              }
            }

            const nextQueue = appendFollowUpQueueState(current.queue, item)
            if (options.coldQueueOnly) {
              return {
                value: undefined,
                next: { ...current, queue: nextQueue },
                persist: true,
              }
            }

            if (current.startingState !== undefined) {
              return {
                value: undefined,
                next: {
                  ...current,
                  queue: nextQueue,
                },
                persist: true,
              }
            }

            const projectedState = projectRuntimeState(current)
            if (projectedState._tag !== "Idle" || current.state._tag !== "Idle") {
              return {
                value: undefined,
                next: { ...current, queue: nextQueue },
                persist: true,
              }
            }

            const reservedRunningState = buildRunningState(current.state, item, { startedAtMs })
            return {
              value: reservedRunningState,
              next: { ...current, startingState: reservedRunningState },
              persist: false,
            }
          },
        ).pipe(
          Effect.flatMap(
            (value): Effect.Effect<RunningState | undefined, AgentLoopError> =>
              Schema.is(AgentLoopError)(value) ? Effect.fail(value) : Effect.succeed(value),
          ),
        )
      })

    const reserveRunStartOrQueueFollowUp = (item: QueuedTurnItem) =>
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis
        return yield* commitQueueTransaction("run start reservation", (current) => {
          if (current.state._tag !== "Idle" || current.startingState !== undefined) {
            const state = current.startingState ?? current.state
            return {
              value: undefined,
              next: { ...current, state, queue: appendFollowUpQueueState(current.queue, item) },
              persist: true,
            }
          }

          return {
            value: {
              stateEpochBaseline: current.stateEpoch,
              turnFailureBaseline: current.turnFailure?.epoch ?? 0,
            },
            next: {
              ...current,
              startingState: buildRunningState(current.state, item, { startedAtMs }),
            },
            persist: false,
          }
        })
      })

    const refreshRuntimeState = Effect.gen(function* () {
      if (!(yield* Ref.get(startedRef))) return
      yield* persistRuntimeState(yield* currentLoopState)
    })

    const takeNextQueuedTurnFromState = (options: { readonly onlyIfIdle: boolean }) =>
      Effect.gen(function* () {
        const queuedCreatedAt = yield* DateTime.nowAsDate
        return yield* commitQueueTransaction("dequeued turn", (s) => {
          if (options.onlyIfIdle && s.state._tag !== "Idle") {
            return { value: undefined, next: s, persist: false }
          }
          const { queue, nextItem } = takeNextQueuedTurn(s.queue, queuedCreatedAt)
          return {
            value: nextItem,
            next: { ...s, queue },
            persist: queue !== s.queue,
          }
        })
      })

    const takeNextQueuedTurnIfIdle = takeNextQueuedTurnFromState({ onlyIfIdle: true })
    const takeNextQueuedTurnCommitted = takeNextQueuedTurnFromState({ onlyIfIdle: false })

    const clearInFlightTurn = (messageId: QueuedTurnItem["message"]["id"]) =>
      commitQueueTransaction("cleared in-flight turn", (s) => {
        const queue = clearInFlightQueuedTurn(s.queue, messageId)
        return {
          value: undefined,
          next: { ...s, queue },
          persist: queue !== s.queue,
        }
      })

    const appendSteering = (item: QueuedTurnItem) =>
      commitQueueTransaction("queued steering", (s) => ({
        value: s.state,
        next: { ...s, queue: appendSteeringItem(s.queue, item) },
        persist: true,
      }))

    const drainQueue = commitQueueTransaction("drained queue", (s) => ({
      value: queueSnapshotFromQueueState(s.queue),
      next: { ...s, queue: drainVisibleQueueItems(s.queue) },
      persist: true,
    }))

    const switchAgentOnState = (state: LoopState, next: AgentNameType): Effect.Effect<LoopState> =>
      Effect.gen(function* () {
        const previous = state.currentAgent ?? DEFAULT_AGENT_NAME
        if (previous === next) return state
        const { turnExtensionRegistry: switchRegistry } = yield* resolveTurnProfile
        const agents = yield* switchRegistry.listAgents()
        const resolved = agents.find((agent) => agent.name === next)
        if (resolved === undefined) return state

        yield* publishEvent(
          AgentSwitched.make({
            sessionId,
            branchId,
            fromAgent: previous,
            toAgent: next,
          }),
        ).pipe(
          Effect.catchEager((error) =>
            Effect.logWarning("failed to publish AgentSwitched").pipe(
              Effect.annotateLogs({ error: String(error) }),
            ),
          ),
        )

        return updateCurrentAgentOnState(state, next)
      }).pipe(Effect.orDie)

    const TurnOutcome = Schema.TaggedUnion({
      Done: {},
      InteractionRequested: {
        pendingRequestId: InteractionRequestId,
        pendingToolCallId: Schema.String,
        currentTurnAgent: AgentName,
      },
    })
    type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

    const executeTools = Effect.fn("AgentLoop.executeTools")(function* (params: {
      messageId: RunningState["message"]["id"]
      step: number
      toolCalls: ReadonlyArray<Prompt.ToolCallPart>
      currentTurnAgent: AgentNameType
      extensionRegistry: ExtensionRegistryService
      permission: PermissionService
      hostCtx: ExtensionHostContext
    }) {
      if (params.toolCalls.length === 0) return

      const toolResultMessageId = toolResultMessageIdForTurn(params.messageId, params.step)
      const existing = yield* messageStorage.getMessage(toolResultMessageId)
      if (existing !== undefined) return

      const toolResults = yield* executeToolCalls({
        toolCalls: params.toolCalls,
        publishEvent: publishEventOrDie,
        sessionId,
        branchId,
        currentTurnAgent: params.currentTurnAgent,
        hostCtx: params.hostCtx,
      }).pipe(
        Effect.provideService(ExtensionRegistry, params.extensionRegistry),
        Effect.provideService(Permission, params.permission),
      )
      yield* persistToolParts({
        sessionId,
        branchId,
        messageId: toolResultMessageId,
        parts: toolResults,
      })
    })

    const collectTurnStream = Effect.fn("AgentLoop.collectTurnStream")(function* (params: {
      messageId: RunningState["message"]["id"]
      step: number
      resolved: ResolvedTurnContext
      extensionRegistry: ExtensionRegistryService
      permission?: PermissionService
      driverRegistry: DriverRegistryService
      hostCtx: ExtensionHostContext
      activeStream: ActiveStreamHandle
    }) {
      const persistAssistantPartsLocal = (
        parts: ReadonlyArray<AssistantResponsePart>,
        createdAt?: Date,
      ) =>
        persistAssistantParts({
          sessionId,
          branchId,
          messageId: assistantMessageIdForTurn(params.messageId, params.step),
          parts,
          createdAt,
          agentName: params.resolved.currentTurnAgent,
        })

      const persistToolPartsLocal = (parts: ReadonlyArray<ToolResponsePart>, createdAt?: Date) =>
        persistToolParts({
          sessionId,
          branchId,
          messageId: toolResultMessageIdForTurn(params.messageId, params.step),
          parts,
          createdAt,
        })

      const sourceEffect = resolveTurnSource({
        resolved: params.resolved,
        publishEvent: publishEventOrDie,
        sessionId,
        branchId,
        activeStream: params.activeStream,
        hostCtx: params.hostCtx,
      }).pipe(
        Effect.provideService(ExtensionRegistry, params.extensionRegistry),
        Effect.provideService(DriverRegistry, params.driverRegistry),
      )
      const source = yield* params.permission !== undefined
        ? sourceEffect.pipe(Effect.provideService(Permission, params.permission))
        : sourceEffect

      if (source === undefined) {
        return {
          responseParts: [],
          messageProjection: { assistant: [], tool: [] },
          interrupted: false,
          streamFailed: true,
          driverKind: params.resolved.driver?._tag === "external" ? "external" : "model",
        }
      }

      yield* publishEventOrDie(StreamStarted.make({ sessionId, branchId }))

      yield* Effect.logInfo("turn-stream.start").pipe(
        Effect.annotateLogs({
          agent: params.resolved.currentTurnAgent,
          driverKind: source.driverKind,
          model: params.resolved.modelId,
          ...(source.driverId !== undefined ? { driverId: source.driverId } : {}),
        }),
      )

      const collected =
        source.driverKind === "model"
          ? yield* source.collect(
              collectModelTurnResponse({
                turnStream: source.stream,
                publishEvent: publishEventOrDie,
                sessionId,
                branchId,
                modelId: params.resolved.modelId,
                activeStream: params.activeStream,
                formatStreamError: source.formatStreamError,
                retryPreOutputFailures: true,
              }),
            )
          : yield* source.collect(
              collectExternalTurnResponse({
                turnStream: source.stream,
                publishEvent: publishEventOrDie,
                sessionId,
                branchId,
                activeStream: params.activeStream,
                formatStreamError: source.formatStreamError,
              }),
            )

      if (collected.interrupted) {
        yield* publishEventOrDie(
          StreamEnded.make({
            sessionId,
            branchId,
            interrupted: true,
          }),
        )
        yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
        return collected
      }

      if (collected.streamFailed) {
        yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
        yield* persistToolPartsLocal(collected.messageProjection.tool)
        return collected
      }

      const streamEndedCost = yield* computeStreamEndedCost({
        modelId: params.resolved.modelId,
        usage: collected.messageProjection.usage,
        getPricing,
      })
      yield* publishEventOrDie(
        StreamEnded.make({
          sessionId,
          branchId,
          ...(collected.messageProjection.usage !== undefined
            ? { usage: collected.messageProjection.usage }
            : {}),
          model: params.resolved.modelId,
          ...(streamEndedCost !== undefined ? { costUsd: streamEndedCost } : {}),
        }),
      )
      yield* Effect.logInfo("stream.end").pipe(
        Effect.annotateLogs({
          driverKind: source.driverKind,
          inputTokens: collected.messageProjection.usage?.inputTokens ?? 0,
          outputTokens: collected.messageProjection.usage?.outputTokens ?? 0,
          toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
        }),
      )

      yield* Ref.update(turnMetricsRef, (m) => ({
        ...m,
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
        inputTokens: m.inputTokens + (collected.messageProjection.usage?.inputTokens ?? 0),
        outputTokens: m.outputTokens + (collected.messageProjection.usage?.outputTokens ?? 0),
        toolCallCount: m.toolCallCount + toolCallsFromResponseParts(collected.responseParts).length,
      }))

      yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
      yield* persistToolPartsLocal(collected.messageProjection.tool)

      return collected
    })

    const finalizeTurn = Effect.fn("AgentLoop.finalizeTurn")(function* (params: {
      messageId: RunningState["message"]["id"]
      startedAtMs: number
      turnInterrupted: boolean
      streamFailed: boolean
      currentAgent: AgentNameType
      extensionRegistry: ExtensionRegistryService
      hostCtx: ExtensionHostContext
    }) {
      const existingMessage = yield* messageStorage.getMessage(params.messageId)
      if (existingMessage?.turnDurationMs !== undefined) {
        const envelope = yield* findPersistedEvent({
          sessionId,
          branchId,
          match: (candidate) =>
            candidate.event._tag === "TurnCompleted" &&
            candidate.event.messageId === params.messageId,
        })
        if (envelope !== undefined) {
          yield* eventPublisher.deliver(envelope)
        }
        return
      }

      const turnEndTime = yield* DateTime.now
      const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - params.startedAtMs

      const envelope = yield* storageTransaction(
        Effect.gen(function* () {
          yield* messageStorage.updateMessageTurnDuration(params.messageId, turnDurationMs)
          return yield* eventPublisher.append(
            TurnCompleted.make({
              sessionId,
              branchId,
              messageId: params.messageId,
              durationMs: Number(turnDurationMs),
              ...(params.turnInterrupted ? { interrupted: true } : {}),
            }),
          )
        }),
      )
      yield* eventPublisher.deliver(envelope)

      yield* Effect.logDebug("finalize.turn-after.start")
      yield* params.extensionRegistry.extensionReactions.emitTurnAfter(
        {
          sessionId,
          branchId,
          durationMs: Number(turnDurationMs),
          agentName: params.currentAgent,
          interrupted: params.turnInterrupted,
        },
        params.hostCtx,
      )
      yield* Effect.logDebug("finalize.turn-after.done")

      yield* Effect.logInfo("turn.completed").pipe(
        Effect.annotateLogs({
          durationMs: Number(turnDurationMs),
          interrupted: params.turnInterrupted,
        }),
      )

      const metrics = yield* Ref.get(turnMetricsRef)
      let status: "ok" | "error" | "interrupted" = "ok"
      if (params.turnInterrupted) status = "interrupted"
      else if (params.streamFailed) status = "error"
      yield* Effect.logInfo("wide-event").pipe(
        Effect.annotateLogs({
          service: "agent-loop",
          method: "turn",
          actor: metrics.agent,
          sessionId,
          branchId,
          model: metrics.model,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          toolCallCount: metrics.toolCallCount,
          durationMs: Number(turnDurationMs),
          interrupted: params.turnInterrupted,
          status,
        }),
      )
    })

    const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
      yield* Ref.set(turnMetricsRef, emptyTurnMetrics())

      const {
        turnExtensionRegistry,
        turnDriverRegistry,
        turnPermission,
        turnBaseSections,
        turnHostCtx,
      } = yield* resolveTurnProfile

      let step = 0
      let interrupted = yield* Ref.get(interruptedRef)
      let streamFailed = false
      let currentTurnAgent: AgentNameType = state.currentAgent ?? DEFAULT_AGENT_NAME

      const resumeStep = 1
      const existingAssistant = yield* messageStorage
        .getMessage(assistantMessageIdForTurn(state.message.id, resumeStep))
        .pipe(Effect.orElseSucceed(() => undefined))
      if (existingAssistant !== undefined && !interrupted) {
        const toolCalls = assistantDraftFromMessage(existingAssistant).toolCalls
        if (toolCalls.length > 0) {
          const existingResults = yield* messageStorage
            .getMessage(toolResultMessageIdForTurn(state.message.id, resumeStep))
            .pipe(Effect.orElseSucceed(() => undefined))
          if (existingResults === undefined) {
            yield* Effect.logInfo("turn.resume-tools")
            const interactionSignal = yield* executeTools({
              messageId: state.message.id,
              step: resumeStep,
              toolCalls,
              currentTurnAgent,
              hostCtx: turnHostCtx,
              extensionRegistry: turnExtensionRegistry,
              permission: turnPermission,
            }).pipe(
              Effect.as(undefined as ToolInteractionPending | undefined),
              Effect.catchIf(Schema.is(ToolInteractionPending), (e) => Effect.succeed(e)),
            )

            if (interactionSignal !== undefined) {
              const { pending, toolCallId } = interactionSignal
              return TurnOutcome.cases.InteractionRequested.make({
                pendingRequestId: pending.requestId,
                pendingToolCallId: toolCallId as string,
                currentTurnAgent,
              })
            }
            step = 1
          }
        }
      }

      while (true) {
        step++
        if (step > DEFAULTS.maxTurnSteps) {
          yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
            Effect.annotateLogs({ step, max: DEFAULTS.maxTurnSteps }),
          )
          break
        }

        if (yield* Ref.get(interruptedRef)) {
          interrupted = true
          break
        }

        yield* persistMessageReceived({ message: state.message })
        yield* clearInFlightTurn(state.message.id)

        const resolved = yield* resolveTurnContext({
          agentOverride: state.agentOverride,
          runSpec: state.runSpec,
          currentAgent: state.currentAgent,
          branchId,
          sessionId,
          publishEvent: publishEventOrDie,
          baseSections: turnBaseSections,
          interactive: state.interactive,
          hostCtx: turnHostCtx,
        }).pipe(
          Effect.provideService(ConfigService, configServiceForRun),
          Effect.provideService(ExtensionRegistry, turnExtensionRegistry),
          Effect.provideService(DriverRegistry, turnDriverRegistry),
        )
        if (resolved === undefined) break

        currentTurnAgent = resolved.currentTurnAgent
        if (step === 1) {
          yield* Ref.update(turnMetricsRef, (m) => ({
            ...m,
            agent: resolved.currentTurnAgent,
            model: resolved.modelId,
          }))
        }

        if (yield* Ref.get(interruptedRef)) {
          interrupted = true
          break
        }

        const collected = yield* Effect.scoped(
          Effect.gen(function* () {
            const activeStream = yield* makeActiveStreamHandle()
            yield* Ref.set(activeStreamRef, activeStream)
            return yield* collectTurnStream({
              messageId: state.message.id,
              step,
              resolved,
              extensionRegistry: turnExtensionRegistry,
              permission: turnPermission,
              driverRegistry: turnDriverRegistry,
              hostCtx: turnHostCtx,
              activeStream,
            })
          }).pipe(Effect.ensuring(Ref.set(activeStreamRef, undefined))),
        )

        if (collected.interrupted) {
          interrupted = true
          break
        }
        if (collected.streamFailed) {
          streamFailed = true
          break
        }

        if (collected.driverKind === "external") break

        const toolCalls = toolCallsFromResponseParts(collected.responseParts)
        if (toolCalls.length === 0) break

        const interactionSignal = yield* executeTools({
          messageId: state.message.id,
          step,
          toolCalls,
          currentTurnAgent: resolved.currentTurnAgent,
          hostCtx: turnHostCtx,
          extensionRegistry: turnExtensionRegistry,
          permission: turnPermission,
        }).pipe(
          Effect.as(undefined as ToolInteractionPending | undefined),
          Effect.catchIf(Schema.is(ToolInteractionPending), (e) => Effect.succeed(e)),
        )

        if (interactionSignal !== undefined) {
          const { pending, toolCallId } = interactionSignal
          return TurnOutcome.cases.InteractionRequested.make({
            pendingRequestId: pending.requestId,
            pendingToolCallId: toolCallId as string,
            currentTurnAgent: resolved.currentTurnAgent,
          })
        }
      }

      yield* finalizeTurn({
        startedAtMs: state.startedAtMs,
        messageId: state.message.id,
        turnInterrupted: interrupted,
        streamFailed,
        currentAgent: currentTurnAgent,
        extensionRegistry: turnExtensionRegistry,
        hostCtx: turnHostCtx,
      })

      return TurnOutcome.cases.Done.make({})
    })

    const saveCheckpoint = (next: LoopState): Effect.Effect<void, AgentLoopError> =>
      persistRuntimeState(next).pipe(
        Effect.catchEager((error) =>
          Deferred.fail(persistenceFailure, error).pipe(
            Effect.asVoid,
            Effect.andThen(Effect.fail(error)),
          ),
        ),
        Effect.withSpan("AgentLoop.durability.save"),
      )

    const enqueueTurnWorker = (state: RunningState): Effect.Effect<void> =>
      TxQueue.offer(turnWorkerQueue, state).pipe(Effect.asVoid)

    const finishTurnWorker = (
      startState: RunningState,
      outcome: TurnOutcome,
    ): Effect.Effect<void, AgentLoopError> =>
      Effect.gen(function* () {
        if (outcome._tag === "InteractionRequested") {
          const next = toWaitingForInteractionState({
            state: startState,
            currentTurnAgent: outcome.currentTurnAgent,
            pendingRequestId: outcome.pendingRequestId,
            pendingToolCallId: outcome.pendingToolCallId,
          })
          yield* saveCheckpoint(next)
          return
        }

        const nextItem = yield* takeNextQueuedTurnCommitted
        yield* Ref.set(interruptedRef, false)
        if (nextItem !== undefined) {
          const startedAtMs = yield* Clock.currentTimeMillis
          const nextRunning = buildRunningState(
            { currentAgent: startState.currentAgent },
            nextItem,
            { startedAtMs },
          )
          yield* saveCheckpoint(nextRunning)
          yield* enqueueTurnWorker(nextRunning)
          return
        }
        yield* saveCheckpoint(buildIdleState({ currentAgent: startState.currentAgent }))
      })

    const failTurnWorker = (
      startState: RunningState,
      cause: Cause.Cause<unknown>,
    ): Effect.Effect<void, AgentLoopError> =>
      Effect.gen(function* () {
        yield* recordTurnFailure(cause)
        yield* publishPhaseFailure({ publishEvent, sessionId, branchId, cause })
        const nextItem = yield* takeNextQueuedTurnCommitted
        const current = yield* currentLoopState
        yield* Ref.set(interruptedRef, false)
        if (nextItem !== undefined) {
          const startedAtMs = yield* Clock.currentTimeMillis
          const nextRunning = buildRunningState(
            { currentAgent: current.currentAgent ?? startState.currentAgent },
            nextItem,
            { startedAtMs },
          )
          yield* saveCheckpoint(nextRunning)
          yield* enqueueTurnWorker(nextRunning)
          return
        }
        yield* saveCheckpoint(
          buildIdleState({ currentAgent: current.currentAgent ?? startState.currentAgent }),
        )
      })

    const runTurnWorker = (startState: RunningState) =>
      sideMutationSemaphore.withPermits(1)(
        runTurn(startState).pipe(
          Effect.annotateLogs({ sessionId, branchId }),
          Effect.withSpan("AgentLoop.turn"),
          Effect.matchCauseEffect({
            onFailure: (cause) => failTurnWorker(startState, cause),
            onSuccess: (outcome) => finishTurnWorker(startState, outcome),
          }),
          Effect.catchCause((cause) =>
            recordTurnFailure(cause).pipe(
              Effect.andThen(publishPhaseFailure({ publishEvent, sessionId, branchId, cause })),
              Effect.ignore,
            ),
          ),
          Effect.ignore,
        ),
      )

    const turnWorkerLoop = TxQueue.take(turnWorkerQueue).pipe(
      Effect.flatMap(runTurnWorker),
      Effect.forever,
      Effect.ignore,
    )

    const startTurnWorker = Effect.forkIn(provideRuntime(turnWorkerLoop), loopScope, {
      startImmediately: true,
    }).pipe(Effect.asVoid)

    const interrupt: Effect.Effect<void, AgentLoopError> = Effect.gen(function* () {
      const snap = yield* currentLoopState
      if (snap._tag === "Idle") return
      if (snap._tag === "Running") {
        yield* Ref.set(interruptedRef, true)
        yield* interruptActiveStream(activeStreamRef)
        return
      }
      yield* sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* currentLoopState
          if (state._tag !== "WaitingForInteraction") return
          yield* Ref.set(interruptedRef, true)
          const resumed = buildRunningState(
            { currentAgent: state.currentAgent },
            {
              message: state.message,
              ...(state.agentOverride !== undefined ? { agentOverride: state.agentOverride } : {}),
              ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
              ...(state.interactive !== undefined ? { interactive: state.interactive } : {}),
            },
            { startedAtMs: state.startedAtMs },
          )
          yield* saveCheckpoint(resumed)
          yield* enqueueTurnWorker(resumed)
        }),
      )
    })

    const startTurn = (item: QueuedTurnItem): Effect.Effect<void, AgentLoopError> =>
      sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* currentLoopState
          if (state._tag !== "Idle") return
          yield* Ref.set(interruptedRef, false)
          const startedAtMs = yield* Clock.currentTimeMillis
          const next = buildRunningState(state, item, { startedAtMs })
          yield* saveCheckpoint(next)
          yield* enqueueTurnWorker(next)
        }),
      )

    const switchAgent = (agent: AgentNameType): Effect.Effect<void, AgentLoopError> =>
      sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* currentLoopState
          const next = yield* switchAgentOnState(state, agent)
          if (next === state) return
          yield* saveCheckpoint(next)
        }),
      )

    const respondInteraction = (
      requestId: InteractionRequestId,
    ): Effect.Effect<void, AgentLoopError> =>
      sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* currentLoopState
          if (state._tag !== "WaitingForInteraction") return
          if (requestId !== state.pendingRequestId) {
            yield* Effect.logWarning(
              "Ignoring stale interaction response for non-pending request",
            ).pipe(
              Effect.annotateLogs({
                sessionId: state.message.sessionId,
                branchId: state.message.branchId,
                expectedRequestId: state.pendingRequestId,
                actualRequestId: requestId,
              }),
            )
            return
          }
          yield* Ref.set(interruptedRef, false)
          const resumed = buildRunningState(
            { currentAgent: state.currentAgent },
            {
              message: state.message,
              ...(state.agentOverride !== undefined ? { agentOverride: state.agentOverride } : {}),
              ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
              ...(state.interactive !== undefined ? { interactive: state.interactive } : {}),
            },
            { startedAtMs: state.startedAtMs },
          )
          yield* saveCheckpoint(resumed)
          yield* enqueueTurnWorker(resumed)
        }),
      )

    const start = Effect.gen(function* () {
      if (yield* Ref.getAndSet(startedRef, true)) return
      yield* startTurnWorker
    })

    const close = Effect.gen(function* () {
      yield* interruptActiveStream(activeStreamRef)
      yield* Deferred.succeed(closed, undefined).pipe(Effect.ignore)
      yield* Scope.close(loopScope, Exit.void)
    }).pipe(Effect.ignore)

    return {
      persistenceFailure: Deferred.await(persistenceFailure),
      readState,
      stateChanges,
      runtimeState,
      queueSnapshot,
      setStartingState,
      reserveStartOrQueueFollowUp,
      reserveRunStartOrQueueFollowUp,
      takeNextQueuedTurnIfIdle,
      takeNextQueuedTurn: takeNextQueuedTurnCommitted,
      appendSteering,
      drainQueue,
      resolveTurnProfile,
      persistState: persistRuntimeState,
      refreshRuntimeState,
      snapshot: currentLoopState,
      startTurn,
      interruptActiveStream: interruptActiveStream(activeStreamRef),
      interrupt,
      switchAgent,
      respondInteraction,
      withSideMutation: (effect) => sideMutationSemaphore.withPermits(1)(effect),
      start,
      awaitExit: Deferred.await(closed),
      close,
    } satisfies AgentLoopBehavior
  })
