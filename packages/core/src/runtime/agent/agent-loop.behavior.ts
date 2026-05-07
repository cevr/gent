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
  Ref,
  Schema,
  Scope,
  TxSubscriptionRef,
  type Semaphore,
  type Stream,
} from "effect"
import {
  AgentName,
  DEFAULT_AGENT_NAME,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { TaggedEnumClass } from "../../domain/schema-tagged-enum-class.js"
import {
  AgentSwitched,
  ErrorOccurred,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
  type AgentEvent,
} from "../../domain/event.js"
import type { EventPublisher } from "../../domain/event-publisher.js"
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
import type { MessageStorage } from "../../storage/message-storage.js"
import type { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import type { ModelResolver } from "../../providers/model-resolver.js"
import { SessionProfileCache } from "../session-profile.js"
import type { ExtensionRegistryService } from "../extensions/registry.js"
import type { DriverRegistry, DriverRegistryService } from "../extensions/driver-registry.js"
import type { ToolRunner } from "./tool-runner.js"
import type { ResourceManagerService } from "../resource-manager.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { AllowAllPermission, resolveSessionEnvironment } from "../session-runtime-context.js"
import {
  buildIdleState,
  buildRunningState,
  emptyLoopQueueState,
  takeNextQueuedTurn,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  buildInitialAgentLoopState,
  appendFollowUpQueueState,
  appendSteeringItem,
  countQueuedFollowUps,
  projectRuntimeState,
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
import { AgentLoopError } from "./agent-loop.commands.js"
import {
  collectExternalTurnResponse,
  collectModelTurnResponse,
  emptyTurnMetrics,
  type ActiveStreamHandle,
} from "./turn-response/collectors.js"
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
  runTurnBeforeHook,
  toolCallsFromResponseParts,
  type AssistantResponsePart,
  type PricingLookup,
  type ResolvedTurnContext,
  type ToolResponsePart,
  type TurnStorage,
} from "./turn-helpers.js"

export const resolveStoredAgent = (params: {
  storage: Pick<TurnStorage, "events">
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<AgentNameType, never> =>
  Effect.gen(function* () {
    const latestAgentEvent = yield* params.storage.events
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
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  sideMutationSemaphore: Semaphore.Semaphore
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
  interrupt: Effect.Effect<void, AgentLoopError>
  switchAgent: (agent: AgentNameType) => Effect.Effect<void, AgentLoopError>
  respondInteraction: (requestId: InteractionRequestId) => Effect.Effect<void, AgentLoopError>
  /** Mark the per-entity behavior ready to accept state mutations. */
  start: Effect.Effect<void, AgentLoopError>
  /** Resolves once the loop scope is closed. */
  awaitExit: Effect.Effect<void>
  resourceManager: ResourceManagerService
  closed: Deferred.Deferred<void>
  scope: Scope.Closeable
}

export const interruptActiveStream = (activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>) =>
  Effect.gen(function* () {
    const activeStream = yield* Ref.get(activeStreamRef)
    if (activeStream === undefined) return
    yield* Ref.set(activeStream.interruptedRef, true)
    yield* Deferred.succeed(activeStream.interruptDeferred, undefined).pipe(Effect.ignore)
    activeStream.abortController.abort()
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
 * Dependencies for `makeAgentLoopBehavior`. Captures the layer-level services
 * needed by the per-entity actor factory.
 */
export type AgentLoopBehaviorDeps = {
  readonly turnStorage: TurnStorage
  readonly modelResolver: typeof ModelResolver.Service
  readonly extensionRegistry: ExtensionRegistryService
  readonly driverRegistry: typeof DriverRegistry.Service
  readonly eventPublisher: typeof EventPublisher.Service
  readonly toolRunner: typeof ToolRunner.Service
  readonly resourceManager: ResourceManagerService
  readonly messageStorage: typeof MessageStorage.Service
  readonly queueStorage: typeof AgentLoopQueueStorage.Service
  readonly sessionStorage: typeof SessionStorage.Service
  readonly configServiceForRun: typeof ConfigService.Service
  readonly getPricing: PricingLookup
  readonly baseSections: ReadonlyArray<PromptSection>
  /**
   * Closure-local follow-up enqueue. Stand-in for the legacy
   * `service.queueFollowUp` recursive reference; in c.1.a it still routes
   * back through the service via mutual recursion. c.1.b makes this a
   * closure-local enqueue with `Message` as the authoritative payload.
   */
  readonly enqueueFollowUp: (input: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    metadata?: MessageMetadata
  }) => Effect.Effect<void, AgentLoopError | StorageError>
}

/**
 * Per-(sessionId, branchId) loop behavior factory.
 *
 * Returns the per-entity behavior primitives used by the actor handlers.
 */
export const makeAgentLoopBehavior = (
  deps: AgentLoopBehaviorDeps,
  sessionId: SessionId,
  branchId: BranchId,
  sideMutationSemaphore: Semaphore.Semaphore,
  initialQueue: LoopQueueState = emptyLoopQueueState(),
): Effect.Effect<AgentLoopBehavior, never, never> =>
  Effect.gen(function* () {
    const {
      turnStorage,
      modelResolver,
      extensionRegistry,
      driverRegistry,
      eventPublisher,
      toolRunner,
      resourceManager,
      messageStorage,
      queueStorage,
      sessionStorage,
      configServiceForRun,
      getPricing,
      baseSections,
      enqueueFollowUp,
    } = deps

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
        sessionControl: {
          queueFollowUp: (input): Effect.Effect<void, AgentLoopError | StorageError> =>
            enqueueFollowUp(input),
        },
      },
    })

    const profileCache = sessionProfileCache._tag === "Some" ? sessionProfileCache.value : undefined
    const defaultPermission =
      permissionService._tag === "Some" ? permissionService.value : AllowAllPermission

    const resolveTurnProfile = resolveSessionEnvironment({
      sessionId,
      branchId,
      sessionStorage,
      hostDeps,
      profileCache,
      defaults: {
        driverRegistry,
        permission: defaultPermission,
        baseSections,
      },
    }).pipe(
      Effect.map(({ environment }) => ({
        turnExtensionRegistry: environment.extensionRegistry,
        turnDriverRegistry: environment.driverRegistry,
        turnPermission: environment.permission,
        turnBaseSections: environment.baseSections,
        turnHostCtx: environment.hostCtx,
      })),
    )

    const loopScope = yield* Scope.make()
    const activeStreamRef = yield* Ref.make<ActiveStreamHandle | undefined>(undefined)
    const turnMetricsRef = yield* Ref.make(emptyTurnMetrics())
    const interruptedRef = yield* Ref.make(false)
    const currentAgent = yield* resolveStoredAgent({
      storage: turnStorage,
      sessionId,
      branchId,
    })
    const initialLoopState = buildIdleState({ currentAgent })
    const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
      buildInitialAgentLoopState({ state: initialLoopState, queue: initialQueue }),
    )
    const persistenceFailure = yield* Deferred.make<void, AgentLoopError>()
    const closed = yield* Deferred.make<void>()
    let started = false

    const persistCommittedQueue = (queue: LoopQueueState, operation: string) =>
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
        : Effect.void

    const commitQueueTransaction = <A>(
      operation: string,
      decide: (state: AgentLoopState) => {
        readonly value: A
        readonly next: AgentLoopState
        readonly persist: boolean
      },
    ): Effect.Effect<A, AgentLoopError> =>
      Effect.gen(function* () {
        const decision = yield* TxSubscriptionRef.modify(loopRef, (state) => {
          const next = decide(state)
          const committed = next.persist
            ? {
                ...next.next,
                stateEpoch: next.next.stateEpoch + 1,
                startingState: undefined,
              }
            : next.next
          return [{ ...next, next: committed }, committed]
        })
        if (decision.persist) {
          yield* persistCommittedQueue(decision.next.queue, operation)
        }
        return decision.value
      })

    const persistRuntimeSnapshot = (state: LoopState, queue: LoopQueueState) =>
      queueStorage.putQueueState(sessionId, branchId, queue).pipe(
        Effect.mapError(
          (cause) =>
            new AgentLoopError({
              message: `Failed to persist loop queue for ${sessionId}/${branchId}`,
              cause,
            }),
        ),
        Effect.andThen(
          TxSubscriptionRef.update(loopRef, (s) => ({
            ...s,
            state,
            queue,
            stateEpoch: s.stateEpoch + 1,
            startingState: undefined,
          })),
        ),
      )

    const persistRuntimeState = (state: LoopState) =>
      TxSubscriptionRef.get(loopRef).pipe(
        Effect.flatMap((s) => persistRuntimeSnapshot(state, s.queue)),
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
                  state: current.startingState,
                  queue: nextQueue,
                  startingState: undefined,
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
      if (!started) return
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

    const appendSteering = (item: QueuedTurnItem) =>
      commitQueueTransaction("queued steering", (s) => ({
        value: s.state,
        next: { ...s, queue: appendSteeringItem(s.queue, item) },
        persist: true,
      }))

    const drainQueue = commitQueueTransaction("drained queue", (s) => ({
      value: queueSnapshotFromQueueState(s.queue),
      next: { ...s, queue: emptyLoopQueueState() },
      persist: true,
    }))

    const switchAgentOnState = (state: LoopState, next: AgentNameType): Effect.Effect<LoopState> =>
      Effect.gen(function* () {
        const previous = state.currentAgent ?? DEFAULT_AGENT_NAME
        if (previous === next) return state
        const { turnExtensionRegistry: switchRegistry } = yield* resolveTurnProfile
        const resolved = yield* switchRegistry.getAgent(next)
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

    const TurnOutcome = TaggedEnumClass("TurnOutcome", {
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
        toolRunner,
        extensionRegistry: params.extensionRegistry,
        permission: params.permission,
        resourceManager,
      })
      yield* persistToolParts({
        storage: turnStorage,
        eventPublisher,
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
      driverRegistry: DriverRegistryService
      hostCtx: ExtensionHostContext
      activeStream: ActiveStreamHandle
    }) {
      const persistAssistantPartsLocal = (
        parts: ReadonlyArray<AssistantResponsePart>,
        createdAt?: Date,
      ) =>
        persistAssistantParts({
          storage: turnStorage,
          eventPublisher,
          sessionId,
          branchId,
          messageId: assistantMessageIdForTurn(params.messageId, params.step),
          parts,
          createdAt,
          agentName: params.resolved.currentTurnAgent,
          extensionRegistry: params.extensionRegistry,
          hostCtx: params.hostCtx,
        })

      const persistToolPartsLocal = (parts: ReadonlyArray<ToolResponsePart>, createdAt?: Date) =>
        persistToolParts({
          storage: turnStorage,
          eventPublisher,
          sessionId,
          branchId,
          messageId: toolResultMessageIdForTurn(params.messageId, params.step),
          parts,
          createdAt,
        })

      const source = yield* resolveTurnSource({
        resolved: params.resolved,
        modelResolver,
        driverRegistry: params.driverRegistry,
        publishEvent: publishEventOrDie,
        sessionId,
        branchId,
        activeStream: params.activeStream,
        hostCtx: params.hostCtx,
      })

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
          storage: turnStorage,
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

      const envelope = yield* turnStorage.transaction.withTransaction(
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
              Effect.catchIf(
                (e): e is ToolInteractionPending => e instanceof ToolInteractionPending,
                (e) => Effect.succeed(e),
              ),
            )

            if (interactionSignal !== undefined) {
              const { pending, toolCallId } = interactionSignal
              return TurnOutcome.InteractionRequested.make({
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

        yield* persistMessageReceived({
          storage: turnStorage,
          eventPublisher,
          message: state.message,
        })

        const resolved = yield* resolveTurnContext({
          agentOverride: state.agentOverride,
          runSpec: state.runSpec,
          currentAgent: state.currentAgent,
          storage: turnStorage,
          branchId,
          extensionRegistry: turnExtensionRegistry,
          driverRegistry: turnDriverRegistry,
          sessionId,
          publishEvent: publishEventOrDie,
          baseSections: turnBaseSections,
          interactive: state.interactive,
          hostCtx: turnHostCtx,
        }).pipe(Effect.provideService(ConfigService, configServiceForRun))
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

        yield* runTurnBeforeHook(turnExtensionRegistry, resolved, sessionId, branchId, turnHostCtx)

        const activeStream: ActiveStreamHandle = {
          abortController: new AbortController(),
          interruptDeferred: yield* Deferred.make<void>(),
          interruptedRef: yield* Ref.make(false),
        }
        yield* Ref.set(activeStreamRef, activeStream)

        const collected = yield* collectTurnStream({
          messageId: state.message.id,
          step,
          resolved,
          extensionRegistry: turnExtensionRegistry,
          driverRegistry: turnDriverRegistry,
          hostCtx: turnHostCtx,
          activeStream,
        }).pipe(Effect.ensuring(Ref.set(activeStreamRef, undefined)))

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
          Effect.catchIf(
            (e): e is ToolInteractionPending => e instanceof ToolInteractionPending,
            (e) => Effect.succeed(e),
          ),
        )

        if (interactionSignal !== undefined) {
          const { pending, toolCallId } = interactionSignal
          return TurnOutcome.InteractionRequested.make({
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

      return TurnOutcome.Done.make({})
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

    const runTurnFiber = (startState: RunningState): Effect.Effect<void, never> =>
      sideMutationSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            const outcome = yield* runTurn(startState).pipe(
              Effect.annotateLogs({ sessionId, branchId }),
              Effect.withSpan("AgentLoop.turn"),
              Effect.tapCause((cause) =>
                recordTurnFailure(cause).pipe(
                  Effect.andThen(publishPhaseFailure({ publishEvent, sessionId, branchId, cause })),
                ),
              ),
            )

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
              yield* forkTurn(nextRunning)
              return
            }
            yield* saveCheckpoint(buildIdleState({ currentAgent: startState.currentAgent }))
          }),
        )
        .pipe(
          Effect.catchCause(() =>
            sideMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const nextItem = yield* takeNextQueuedTurnCommitted
                const current = yield* currentLoopState
                yield* Ref.set(interruptedRef, false)
                if (nextItem !== undefined) {
                  const startedAtMs = yield* Clock.currentTimeMillis
                  const nextRunning = buildRunningState(
                    { currentAgent: current.currentAgent },
                    nextItem,
                    { startedAtMs },
                  )
                  yield* saveCheckpoint(nextRunning)
                  yield* forkTurn(nextRunning)
                  return
                }
                yield* saveCheckpoint(buildIdleState({ currentAgent: current.currentAgent }))
              }),
            ),
          ),
          Effect.ignore,
        )

    const forkTurn = (startState: RunningState): Effect.Effect<void> =>
      Effect.forkIn(runTurnFiber(startState), loopScope, { startImmediately: true }).pipe(
        Effect.asVoid,
      )

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
          yield* forkTurn(resumed)
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
          yield* forkTurn(next)
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
          yield* forkTurn(resumed)
        }),
      )

    const start = Effect.sync(() => {
      if (started) return
      started = true
    })

    return {
      activeStreamRef,
      sideMutationSemaphore,
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
      interrupt,
      switchAgent,
      respondInteraction,
      start,
      awaitExit: Deferred.await(closed),
      resourceManager,
      closed,
      scope: loopScope,
    } satisfies AgentLoopBehavior
  })
