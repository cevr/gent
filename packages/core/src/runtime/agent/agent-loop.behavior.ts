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
  emptyLoopQueueState,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  buildInitialAgentLoopState,
  AgentLoopError,
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
import { makeAgentLoopQueue } from "./agent-loop.queue.js"
import { WideEvent, turnBoundary, withWideEvent } from "../wide-event-boundary.js"

const MAX_TURN_STEPS = 200

export const resolveStoredAgent = Effect.fn("AgentLoop.resolveStoredAgent")(function* (params: {
  sessionId: SessionId
  branchId: BranchId
}) {
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

export const interruptActiveStream = Effect.fn("AgentLoop.interruptActiveStream")(function* (
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>,
) {
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

    type BehaviorDeps = {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly sideMutationSemaphore: Semaphore.Semaphore
      readonly baseSections: ReadonlyArray<PromptSection>
      readonly enqueueFollowUp: EnqueueFollowUp
      readonly messageStorage: typeof messageStorage
      readonly queueStorage: typeof queueStorage
      readonly eventPublisher: typeof eventPublisher
      readonly storageTransaction: typeof storageTransaction
      readonly provideRuntime: typeof provideRuntime
      readonly getPricing: PricingLookup
      readonly publishEvent: typeof publishEvent
      readonly publishEventOrDie: typeof publishEventOrDie
      readonly resolveTurnProfile: typeof resolveTurnProfile
      readonly hostDeps: typeof hostDeps
      readonly configServiceForRun: typeof configServiceForRun
      readonly modelRegistryForRun: typeof modelRegistryForRun
      readonly host: typeof host
      readonly extensionRegistry: typeof extensionRegistry
      readonly driverRegistry: typeof driverRegistry
      readonly loopScope: typeof loopScope
      readonly turnWorkerQueue: typeof turnWorkerQueue
      readonly activeStreamRef: typeof activeStreamRef
      readonly turnMetricsRef: typeof turnMetricsRef
      readonly interruptedRef: typeof interruptedRef
      readonly loopRef: typeof loopRef
      readonly queuePersistenceSemaphore: typeof queuePersistenceSemaphore
      readonly persistenceFailure: typeof persistenceFailure
      readonly closed: typeof closed
      readonly startedRef: typeof startedRef
    }

    const behaviorDeps = {
      sessionId,
      branchId,
      sideMutationSemaphore,
      baseSections,
      enqueueFollowUp,
      messageStorage,
      queueStorage,
      eventPublisher,
      storageTransaction,
      provideRuntime,
      getPricing,
      publishEvent,
      publishEventOrDie,
      resolveTurnProfile,
      hostDeps,
      configServiceForRun,
      modelRegistryForRun,
      host,
      extensionRegistry,
      driverRegistry,
      loopScope,
      turnWorkerQueue,
      activeStreamRef,
      turnMetricsRef,
      interruptedRef,
      loopRef,
      queuePersistenceSemaphore,
      persistenceFailure,
      closed,
      startedRef,
    } satisfies BehaviorDeps

    const queue = makeAgentLoopQueue({
      sessionId: behaviorDeps.sessionId,
      branchId: behaviorDeps.branchId,
      queueStorage: behaviorDeps.queueStorage,
      loopRef: behaviorDeps.loopRef,
      queuePersistenceSemaphore: behaviorDeps.queuePersistenceSemaphore,
      persistenceFailure: behaviorDeps.persistenceFailure,
      startedRef: behaviorDeps.startedRef,
    })

    const recordTurnFailure = (cause: Cause.Cause<unknown>) =>
      TxSubscriptionRef.update(loopRef, (s) => ({
        ...s,
        turnFailure: {
          epoch: (s.turnFailure?.epoch ?? 0) + 1,
          error: causeToAgentLoopError(cause),
        },
      }))

    const {
      readState,
      stateChanges,
      runtimeState,
      queueSnapshot,
      currentLoopState,
      persistRuntimeState,
      refreshRuntimeState,
      setStartingState,
      reserveStartOrQueueFollowUp,
      reserveRunStartOrQueueFollowUp,
      takeNextQueuedTurnIfIdle,
      takeNextQueuedTurn: takeNextQueuedTurnCommitted,
      clearInFlightTurn,
      appendSteering,
      drainQueue,
      saveCheckpoint,
    } = queue

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
      })
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

      const source = yield* resolveTurnSource({
        resolved: params.resolved,
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
      hostCtx: ExtensionHostContext
    }) {
      const extensionRegistry = yield* ExtensionRegistry
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
      yield* extensionRegistry.extensionReactions.emitTurnAfter(
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
      yield* WideEvent.set({
        actor: metrics.agent,
        model: metrics.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        toolCallCount: metrics.toolCallCount,
        interrupted: params.turnInterrupted,
        ...(params.streamFailed && !params.turnInterrupted ? { streamFailed: true } : {}),
      })
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
            }).pipe(
              Effect.provideService(ExtensionRegistry, turnExtensionRegistry),
              Effect.provideService(Permission, turnPermission),
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
        if (step > MAX_TURN_STEPS) {
          yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
            Effect.annotateLogs({ step, max: MAX_TURN_STEPS }),
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
              hostCtx: turnHostCtx,
              activeStream,
            }).pipe(
              Effect.provideService(ExtensionRegistry, turnExtensionRegistry),
              Effect.provideService(DriverRegistry, turnDriverRegistry),
              Effect.provideService(Permission, turnPermission),
            )
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
        }).pipe(
          Effect.provideService(ExtensionRegistry, turnExtensionRegistry),
          Effect.provideService(Permission, turnPermission),
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
        hostCtx: turnHostCtx,
      }).pipe(Effect.provideService(ExtensionRegistry, turnExtensionRegistry))

      return TurnOutcome.cases.Done.make({})
    })

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
          withWideEvent(
            turnBoundary(sessionId, branchId, startState.currentAgent ?? DEFAULT_AGENT_NAME),
          ),
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
    }).pipe(Effect.withSpan("AgentLoop.interrupt"))

    const startTurn = Effect.fn("AgentLoop.startTurn")((item: QueuedTurnItem) =>
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
      ),
    )

    const switchAgent = Effect.fn("AgentLoop.switchAgent")((agent: AgentNameType) =>
      sideMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* currentLoopState
          const next = yield* switchAgentOnState(state, agent)
          if (next === state) return
          yield* saveCheckpoint(next)
        }),
      ),
    )

    const respondInteraction = Effect.fn("AgentLoop.respondInteraction")(
      (requestId: InteractionRequestId) =>
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
                ...(state.agentOverride !== undefined
                  ? { agentOverride: state.agentOverride }
                  : {}),
                ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
                ...(state.interactive !== undefined ? { interactive: state.interactive } : {}),
              },
              { startedAtMs: state.startedAtMs },
            )
            yield* saveCheckpoint(resumed)
            yield* enqueueTurnWorker(resumed)
          }),
        ),
    )

    const start = Effect.gen(function* () {
      if (yield* Ref.getAndSet(startedRef, true)) return
      yield* startTurnWorker
    }).pipe(Effect.withSpan("AgentLoop.start"))

    const close = Effect.gen(function* () {
      yield* interruptActiveStream(activeStreamRef)
      yield* Deferred.succeed(closed, undefined).pipe(Effect.ignore)
      yield* Scope.close(loopScope, Exit.void)
    }).pipe(Effect.ignore, Effect.withSpan("AgentLoop.close"))

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
