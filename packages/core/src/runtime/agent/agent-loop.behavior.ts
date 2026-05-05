/**
 * Per-(sessionId, branchId) loop behavior factory.
 *
 * Extracted from the legacy `AgentLoop.Live` factory closure as the first
 * step of C5.4.4.c.1 (the γ-shaped split). Pure code-move: same primitives,
 * same recovery flow, same `LoopHandle` shape — only the `service.queueFollowUp`
 * recursive reference is replaced by an explicit `enqueueFollowUp` callback
 * parameter. C5.4.4.c.1.b relocates the call site from the legacy `getLoop`
 * to `Actor.toLayer(...)` build (per-entity scoping by encore).
 *
 * @module
 */

import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Effect,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  SubscriptionRef,
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
  TurnRecoveryApplied,
  AgentLoopRecoveryAbandoned,
  type RecoveryAbandonReason,
  type AgentEvent,
} from "../../domain/event.js"
import type { EventPublisher } from "../../domain/event-publisher.js"
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
import type { CheckpointStorage } from "../../storage/checkpoint-storage.js"
import type { Provider } from "../../providers/provider.js"
import { SessionProfileCache } from "../session-profile.js"
import type { ExtensionRegistryService } from "../extensions/registry.js"
import type { DriverRegistry, DriverRegistryService } from "../extensions/driver-registry.js"
import type { ToolRunner } from "./tool-runner.js"
import type { ResourceManagerService } from "../resource-manager.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { AllowAllPermission, resolveSessionEnvironment } from "../session-runtime-context.js"
import {
  AGENT_LOOP_CHECKPOINT_VERSION,
  buildLoopCheckpointRecord,
  decodeLoopCheckpointState,
  RecoveryOutcome,
  shouldRetainLoopCheckpoint,
} from "./agent-loop.checkpoint.js"
import {
  buildIdleState,
  buildRunningState,
  emptyLoopQueueState,
  takeNextQueuedTurn,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  buildInitialAgentLoopState,
  type AgentLoopState,
  type LoopQueueState,
  type LoopState,
  QueuedTurnItemSchema,
  type RunningState,
} from "./agent-loop.state.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import { AgentLoopError } from "./agent-loop.commands.js"
import { emptyTurnMetrics, type ActiveStreamHandle } from "./turn-response/collectors.js"
import {
  ToolInteractionPending,
  executeToolsPhase,
  finalizeTurnPhase,
  resolveTurnPhase,
  runTurnBeforeHook,
  runTurnStreamPhase,
  toolCallsFromResponseParts,
  type PricingLookup,
  type TurnStorage,
} from "./phases/turn.js"

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

// Driver event surface that replaces effect-machine's `actor.call(Event)`.
// Internal driver-event union. Each variant maps to a transition the FSM
// driver previously owned. Not persisted.
export const LoopDriverEvent = TaggedEnumClass("LoopDriverEvent", {
  Start: { item: QueuedTurnItemSchema },
  Interrupt: {},
  SwitchAgent: { agent: AgentName },
  InteractionResponded: { requestId: InteractionRequestId },
})
export type LoopDriverEvent = Schema.Schema.Type<typeof LoopDriverEvent>

export type LoopHandle = {
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  loopRef: SubscriptionRef.SubscriptionRef<AgentLoopState>
  sideMutationSemaphore: Semaphore.Semaphore
  queueMutationSemaphore: Semaphore.Semaphore
  persistenceFailure: Effect.Effect<void, AgentLoopError>
  resolveTurnProfile: Effect.Effect<{
    turnExtensionRegistry: ExtensionRegistryService
    turnDriverRegistry: DriverRegistryService
    turnPermission: PermissionService
    turnBaseSections: ReadonlyArray<PromptSection>
    turnHostCtx: ExtensionHostContext
  }>
  persistState: (state: LoopState) => Effect.Effect<void, AgentLoopError>
  refreshRuntimeState: Effect.Effect<void, AgentLoopError>
  updateQueue: (
    update: (queue: LoopQueueState) => LoopQueueState,
  ) => Effect.Effect<void, AgentLoopError>
  persistQueueSnapshot: (
    state: LoopState,
    queue: LoopQueueState,
  ) => Effect.Effect<void, AgentLoopError>
  persistQueueCurrentState: (queue: LoopQueueState) => Effect.Effect<void, AgentLoopError>
  persistQueueState: (queue: LoopQueueState) => Effect.Effect<void, AgentLoopError>
  /** Read the current FSM state. Replaces effect-machine `actor.snapshot`. */
  snapshot: Effect.Effect<LoopState>
  /** Apply a driver event under the side-mutation semaphore. */
  dispatch: (event: LoopDriverEvent) => Effect.Effect<void, AgentLoopError>
  /** Recover from persisted checkpoint, then start the initial turn fiber if Running. */
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

type LoopRecoveryDecision = {
  state: LoopState
  queue: LoopQueueState
  recovery?: {
    phase: "Idle" | "Running" | "WaitingForInteraction"
    action: "resume-queued-turn" | "replay-running" | "restore-cold"
    detail?: string
  }
}

/** Recovery decision for persist.onRestore — takes decoded state, returns adjusted state or None. */
const makeRecoveryDecision = (params: {
  checkpoint: {
    state: LoopState
    queue: LoopQueueState
  }
  extensionRegistry: ExtensionRegistryService
  currentAgent: AgentNameType
  publishEvent: (event: AgentEvent) => Effect.Effect<void, never>
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<Option.Option<LoopRecoveryDecision>, StorageError> =>
  Effect.gen(function* () {
    const { state } = params.checkpoint
    const queue = params.checkpoint.queue

    const publishRecovery = (recovery: LoopRecoveryDecision["recovery"]) =>
      recovery === undefined
        ? Effect.void
        : params
            .publishEvent(
              TurnRecoveryApplied.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                phase: recovery.phase,
                action: recovery.action,
                ...(recovery.detail !== undefined ? { detail: recovery.detail } : {}),
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void))

    if (state._tag === "Idle") {
      const queuedCreatedAt = yield* DateTime.nowAsDate
      const { queue: remainingQueue, nextItem } = takeNextQueuedTurn(queue, queuedCreatedAt)
      if (nextItem !== undefined) {
        yield* publishRecovery({ phase: "Idle", action: "resume-queued-turn" })
        const startedAtMs = yield* Clock.currentTimeMillis
        return Option.some({
          state: buildRunningState(
            { currentAgent: state.currentAgent ?? params.currentAgent },
            nextItem,
            { startedAtMs },
          ),
          queue: remainingQueue,
        })
      }
      return Option.some(
        state.currentAgent === undefined
          ? {
              state: updateCurrentAgentOnState(state, params.currentAgent),
              queue,
            }
          : {
              state,
              queue,
            },
      )
    }

    if (state._tag === "Running") {
      yield* publishRecovery({ phase: "Running", action: "replay-running" })
      return Option.some({ state, queue })
    }

    if (state._tag === "WaitingForInteraction") {
      yield* publishRecovery({ phase: "WaitingForInteraction", action: "restore-cold" })
      return Option.some({ state, queue })
    }

    return Option.none()
  })

/**
 * Dependencies for `makeAgentLoopBehavior`. Captures the layer-level services
 * the legacy `AgentLoop.Live` factory closed over, lifted to an explicit
 * record so the per-entity factory can be invoked outside the legacy layer
 * (e.g. from `Actor.toLayer` build in C5.4.4.c.1.b).
 */
export type AgentLoopBehaviorDeps = {
  readonly turnStorage: TurnStorage
  readonly checkpointStorage: typeof CheckpointStorage.Service
  readonly provider: typeof Provider.Service
  readonly extensionRegistry: ExtensionRegistryService
  readonly driverRegistry: typeof DriverRegistry.Service
  readonly eventPublisher: typeof EventPublisher.Service
  readonly toolRunner: typeof ToolRunner.Service
  readonly resourceManager: ResourceManagerService
  readonly messageStorage: typeof MessageStorage.Service
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
 * Returns a `LoopHandle` capturing all per-entity primitives (loopRef, scope,
 * semaphores, etc.) and the dispatch/start/snapshot surface the legacy
 * service uses. Mirrors the original `makeLoop` body 1:1 except for the
 * `enqueueFollowUp` parameterization (formerly `service.queueFollowUp`).
 */
export const makeAgentLoopBehavior = (
  deps: AgentLoopBehaviorDeps,
  sessionId: SessionId,
  branchId: BranchId,
  sideMutationSemaphore: Semaphore.Semaphore,
  initialQueue: LoopQueueState = emptyLoopQueueState(),
): Effect.Effect<LoopHandle, never, never> =>
  Effect.gen(function* () {
    const {
      turnStorage,
      checkpointStorage,
      provider,
      extensionRegistry,
      driverRegistry,
      eventPublisher,
      toolRunner,
      resourceManager,
      messageStorage,
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
    const loopRef = yield* SubscriptionRef.make<AgentLoopState>(
      buildInitialAgentLoopState({ state: initialLoopState, queue: initialQueue }),
    )
    const queueMutationSemaphore = yield* Semaphore.make(1)
    const persistenceFailure = yield* Deferred.make<void, AgentLoopError>()
    const closed = yield* Deferred.make<void>()
    let started = false

    const persistRuntimeSnapshot = (state: LoopState, queue: LoopQueueState) =>
      Effect.gen(function* () {
        yield* Effect.logDebug("checkpoint.save.start").pipe(
          Effect.annotateLogs({ nextState: state._tag }),
        )
        if (!shouldRetainLoopCheckpoint({ state, queue })) {
          yield* checkpointStorage.remove({ sessionId, branchId })
          yield* Effect.logDebug("checkpoint.save.removed")
          yield* SubscriptionRef.update(loopRef, (s) => ({
            ...s,
            state,
            queue,
            stateEpoch: s.stateEpoch + 1,
            startingState: undefined,
          }))
          return
        }
        yield* checkpointStorage.upsert(
          yield* buildLoopCheckpointRecord({
            sessionId,
            branchId,
            state,
            queue,
          }),
        )
        yield* Effect.logDebug("checkpoint.save.done").pipe(
          Effect.annotateLogs({ nextState: state._tag }),
        )
        yield* SubscriptionRef.update(loopRef, (s) => ({
          ...s,
          state,
          queue,
          stateEpoch: s.stateEpoch + 1,
          startingState: undefined,
        }))
      }).pipe(
        Effect.mapError(
          (error) =>
            new AgentLoopError({
              message: "Failed to persist agent loop checkpoint",
              cause: error,
            }),
        ),
      )

    const persistRuntimeState = (state: LoopState) =>
      SubscriptionRef.get(loopRef).pipe(
        Effect.flatMap((s) => persistRuntimeSnapshot(state, s.queue)),
      )

    const recordTurnFailure = (cause: Cause.Cause<unknown>) =>
      SubscriptionRef.update(loopRef, (s) => ({
        ...s,
        turnFailure: {
          epoch: (s.turnFailure?.epoch ?? 0) + 1,
          error: causeToAgentLoopError(cause),
        },
      }))

    const currentLoopState = SubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.state))

    const refreshRuntimeState = Effect.gen(function* () {
      if (!started) return
      yield* persistRuntimeState(yield* currentLoopState)
    })

    const updateQueue = (update: (queue: LoopQueueState) => LoopQueueState) =>
      queueMutationSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (!started) return
          const current = yield* SubscriptionRef.get(loopRef)
          const nextQueue = update(current.queue)
          yield* persistRuntimeSnapshot(current.state, nextQueue)
        }),
      )

    const persistQueueState = (nextQueue: LoopQueueState) =>
      Effect.gen(function* () {
        if (!started) return
        yield* persistRuntimeSnapshot(yield* currentLoopState, nextQueue)
      })

    const persistQueueSnapshot = (state: LoopState, nextQueue: LoopQueueState) =>
      persistRuntimeSnapshot(state, nextQueue)

    const persistQueueCurrentState = (nextQueue: LoopQueueState) =>
      SubscriptionRef.get(loopRef).pipe(
        Effect.flatMap((s) => persistRuntimeSnapshot(s.state, nextQueue)),
      )

    const takeNextQueuedTurnSerialized = queueMutationSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const queuedCreatedAt = yield* DateTime.nowAsDate
        return yield* SubscriptionRef.modify(loopRef, (s) => {
          const { queue, nextItem } = takeNextQueuedTurn(s.queue, queuedCreatedAt)
          return [{ nextItem }, { ...s, queue }]
        })
      }),
    )

    const switchAgentOnState = <S extends LoopState>(
      state: S,
      next: AgentNameType,
    ): Effect.Effect<S> =>
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
      }).pipe(Effect.orDie) as Effect.Effect<S>

    const TurnOutcome = TaggedEnumClass("TurnOutcome", {
      Done: {},
      InteractionRequested: {
        pendingRequestId: InteractionRequestId,
        pendingToolCallId: Schema.String,
        currentTurnAgent: AgentName,
      },
    })
    type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

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
            const interactionSignal = yield* executeToolsPhase({
              messageId: state.message.id,
              step: resumeStep,
              toolCalls,
              publishEvent: publishEventOrDie,
              eventPublisher,
              sessionId,
              branchId,
              currentTurnAgent,
              hostCtx: turnHostCtx,
              toolRunner,
              extensionRegistry: turnExtensionRegistry,
              permission: turnPermission,
              resourceManager,
              storage: turnStorage,
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

        const resolved = yield* resolveTurnPhase({
          message: state.message,
          agentOverride: state.agentOverride,
          runSpec: state.runSpec,
          currentAgent: state.currentAgent,
          storage: turnStorage,
          branchId,
          extensionRegistry: turnExtensionRegistry,
          driverRegistry: turnDriverRegistry,
          sessionId,
          publishEvent: publishEventOrDie,
          eventPublisher,
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

        const collected = yield* runTurnStreamPhase({
          messageId: state.message.id,
          step,
          resolved,
          provider,
          extensionRegistry: turnExtensionRegistry,
          driverRegistry: turnDriverRegistry,
          hostCtx: turnHostCtx,
          publishEvent: publishEventOrDie,
          eventPublisher,
          storage: turnStorage,
          sessionId,
          branchId,
          activeStream,
          turnMetrics: turnMetricsRef,
          getPricing,
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

        const interactionSignal = yield* executeToolsPhase({
          messageId: state.message.id,
          step,
          toolCalls,
          publishEvent: publishEventOrDie,
          eventPublisher,
          sessionId,
          branchId,
          currentTurnAgent: resolved.currentTurnAgent,
          hostCtx: turnHostCtx,
          toolRunner,
          extensionRegistry: turnExtensionRegistry,
          permission: turnPermission,
          resourceManager,
          storage: turnStorage,
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

      yield* finalizeTurnPhase({
        storage: turnStorage,
        eventPublisher,
        sessionId,
        branchId,
        startedAtMs: state.startedAtMs,
        messageId: state.message.id,
        turnInterrupted: interrupted,
        streamFailed,
        currentAgent: currentTurnAgent,
        extensionRegistry: turnExtensionRegistry,
        turnMetrics: turnMetricsRef,
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

            const { nextItem } = yield* takeNextQueuedTurnSerialized
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
                const { nextItem } = yield* takeNextQueuedTurnSerialized
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

    const dispatch = (event: LoopDriverEvent): Effect.Effect<void, AgentLoopError> =>
      Effect.gen(function* () {
        if (event._tag === "Interrupt") {
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
                  ...(state.agentOverride !== undefined
                    ? { agentOverride: state.agentOverride }
                    : {}),
                  ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
                  ...(state.interactive !== undefined ? { interactive: state.interactive } : {}),
                },
                { startedAtMs: state.startedAtMs },
              )
              yield* saveCheckpoint(resumed)
              yield* forkTurn(resumed)
            }),
          )
          return
        }

        yield* sideMutationSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* currentLoopState

            switch (event._tag) {
              case "Start": {
                if (state._tag !== "Idle") return
                yield* Ref.set(interruptedRef, false)
                const startedAtMs = yield* Clock.currentTimeMillis
                const next = buildRunningState(state, event.item, { startedAtMs })
                yield* saveCheckpoint(next)
                yield* forkTurn(next)
                return
              }
              case "SwitchAgent": {
                const next = yield* switchAgentOnState(state, event.agent)
                if (next === state) return
                yield* saveCheckpoint(next)
                return
              }
              case "InteractionResponded": {
                if (state._tag !== "WaitingForInteraction") return
                if (event.requestId !== state.pendingRequestId) {
                  yield* Effect.logWarning(
                    "Ignoring stale interaction response for non-pending request",
                  ).pipe(
                    Effect.annotateLogs({
                      sessionId: state.message.sessionId,
                      branchId: state.message.branchId,
                      expectedRequestId: state.pendingRequestId,
                      actualRequestId: event.requestId,
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
                yield* forkTurn(resumed)
                return
              }
            }
          }),
        )
      })

    const publishRecoveryAbandoned = (params: { reason: RecoveryAbandonReason; detail?: string }) =>
      publishEvent(
        AgentLoopRecoveryAbandoned.make({
          sessionId,
          branchId,
          reason: params.reason,
          ...(params.detail !== undefined ? { detail: params.detail } : {}),
        }),
      )

    const failRecovery = (params: {
      reason: RecoveryAbandonReason
      message: string
      cause: unknown
    }) =>
      publishRecoveryAbandoned({
        reason: params.reason,
        detail: String(params.cause),
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new AgentLoopError({
              message: params.message,
              cause: params.cause,
            }),
          ),
        ),
      )

    const removeAbandonedCheckpoint = (params: {
      reason: RecoveryAbandonReason
      detail?: string
    }) =>
      publishRecoveryAbandoned(params).pipe(
        Effect.andThen(
          checkpointStorage.remove({ sessionId, branchId }).pipe(
            Effect.catchEager((error) =>
              failRecovery({
                reason: "checkpoint-remove-failed",
                message: "Failed to remove abandoned agent loop checkpoint",
                cause: error,
              }),
            ),
          ),
        ),
      )

    const resolveRecovery = Effect.gen(function* () {
      if (started) return
      started = true

      const record = yield* checkpointStorage.get({ sessionId, branchId }).pipe(
        Effect.catchCause((cause) =>
          failRecovery({
            reason: "checkpoint-read-failed",
            message: "Failed to read agent loop checkpoint",
            cause: Cause.squash(cause),
          }),
        ),
      )
      if (record === undefined) {
        return RecoveryOutcome.NoCheckpoint.make({})
      }
      if (record.version !== AGENT_LOOP_CHECKPOINT_VERSION) {
        yield* removeAbandonedCheckpoint({
          reason: "checkpoint-version-mismatch",
          detail: `expected=${AGENT_LOOP_CHECKPOINT_VERSION} actual=${record.version}`,
        })
        return RecoveryOutcome.Abandoned.make({
          reason: "checkpoint-version-mismatch",
          detail: `expected=${AGENT_LOOP_CHECKPOINT_VERSION} actual=${record.version}`,
        })
      }
      const decoded = yield* decodeLoopCheckpointState(record.stateJson).pipe(
        Effect.map(Option.some),
        Effect.catchCause((cause) =>
          removeAbandonedCheckpoint({
            reason: "checkpoint-decode-failed",
            detail: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none())),
        ),
      )
      if (Option.isNone(decoded)) {
        return RecoveryOutcome.Abandoned.make({
          reason: "checkpoint-decode-failed",
        })
      }
      const recovered = yield* makeRecoveryDecision({
        checkpoint: decoded.value,
        extensionRegistry,
        currentAgent,
        publishEvent: publishEventOrDie,
        sessionId,
        branchId,
      }).pipe(
        Effect.catchEager((error) =>
          failRecovery({
            reason: "recovery-decision-failed",
            message: "Failed to recover agent loop checkpoint",
            cause: error,
          }),
        ),
      )

      if (Option.isNone(recovered)) return RecoveryOutcome.NoCheckpoint.make({})

      yield* SubscriptionRef.update(loopRef, (s) => ({
        ...s,
        state: recovered.value.state,
        queue: recovered.value.queue,
        stateEpoch: s.stateEpoch + 1,
        startingState: undefined,
      }))
      if (recovered.value.state._tag === "Running") {
        yield* forkTurn(recovered.value.state as RunningState)
      }
      return RecoveryOutcome.Recovered.make({
        stateTag: recovered.value.state._tag,
      })
    }).pipe(Effect.withSpan("AgentLoop.recovery.resolve"))

    const start = resolveRecovery.pipe(Effect.asVoid)

    return {
      activeStreamRef,
      loopRef,
      sideMutationSemaphore,
      queueMutationSemaphore,
      persistenceFailure: Deferred.await(persistenceFailure),
      resolveTurnProfile,
      persistState: persistRuntimeState,
      refreshRuntimeState,
      updateQueue,
      persistQueueSnapshot,
      persistQueueCurrentState,
      persistQueueState,
      snapshot: currentLoopState,
      dispatch,
      start,
      awaitExit: Deferred.await(closed),
      resourceManager,
      closed,
      scope: loopScope,
    } satisfies LoopHandle
  })
