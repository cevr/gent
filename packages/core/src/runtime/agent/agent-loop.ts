import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import {
  AgentName,
  AgentRunError,
  DEFAULT_AGENT_NAME,
  type RunSpec,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { emptyQueueSnapshot, type QueueSnapshot } from "../../domain/queue.js"
import { TaggedEnumClass } from "../../domain/schema-tagged-enum-class.js"
import {
  AgentSwitched,
  ErrorOccurred,
  TurnRecoveryApplied,
  AgentLoopRecoveryAbandoned,
  type RecoveryAbandonReason,
  type AgentEvent,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { Message, TextPart } from "../../domain/message.js"
import {
  InteractionRequestId,
  MessageId,
  type ToolCallId,
  type ActorCommandId,
  type BranchId,
  type SessionId,
} from "../../domain/ids.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { makeAmbientExtensionHostContextDeps } from "../make-extension-host-context.js"
import { ConfigService } from "../config-service.js"
import { ModelRegistry } from "../model-registry.js"
import { DEFAULTS } from "../../domain/defaults.js"
import type { PromptSection } from "../../domain/prompt.js"
import { Storage, type StorageError, type StorageService } from "../../storage/sqlite-storage.js"
import { CheckpointStorage } from "../../storage/checkpoint-storage.js"
import { Provider } from "../../providers/provider.js"
import { SessionProfileCache } from "../session-profile.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "../extensions/driver-registry.js"
import { ActorEngine } from "../extensions/actor-engine.js"
import { Receptionist } from "../extensions/receptionist.js"
import {
  ExtensionRuntime,
  type ExtensionRuntimeService,
} from "../extensions/resource-host/extension-runtime.js"
import {
  ExtensionTurnControl,
  TurnControlError,
  type CurrentTurnControlOwnerService,
  type TurnControlEnvelope,
} from "../extensions/turn-control.js"
import { ToolRunner } from "./tool-runner"
import { ResourceManager, type ResourceManagerService } from "../resource-manager.js"
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
  appendFollowUpQueueState,
  appendSteeringItem,
  buildIdleState,
  buildRunningState,
  countQueuedFollowUps,
  emptyLoopQueueState,
  LoopRuntimeStateSchema,
  queueSnapshotFromQueueState,
  runtimeStateFromLoopState,
  takeNextQueuedTurn,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  buildInitialAgentLoopState,
  projectRuntimeState,
  type AgentLoopState,
  type LoopQueueState,
  type LoopRuntimeState,
  type LoopState,
  QueuedTurnItemSchema,
  type QueuedTurnItem,
  type RunningState,
} from "./agent-loop.state.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import {
  AgentLoopError,
  SteerCommand,
  assistantMessageIdForCommand,
  makeCommandId,
  toolCallIdForCommand,
  toolResultMessageIdForCommand,
  type ApplySteerCommand,
  type InvokeToolCommand,
  type LoopCommand,
  type RecordToolResultCommand,
  type RespondInteractionCommand,
  type RunTurnCommand,
  type SubmitTurnCommand,
} from "./agent-loop.commands.js"
import { emptyTurnMetrics, type ActiveStreamHandle } from "./turn-response/collectors.js"
export { AgentLoopError, SteerCommand }
import {
  ToolInteractionPending,
  executeToolsPhase,
  finalizeTurnPhase,
  invokeToolPhase,
  persistMessageReceived,
  recordToolResultPhase,
  resolveTurnPhase,
  runTurnBeforeHook,
  runTurnStreamPhase,
  toolCallsFromResponseParts,
  type PricingLookup,
} from "./phases/turn.js"

// Agent Loop Context

const resolveStoredAgent = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<AgentNameType, never> =>
  Effect.gen(function* () {
    const latestAgentEvent = yield* params.storage
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
const LoopDriverEvent = TaggedEnumClass("LoopDriverEvent", {
  Start: { item: QueuedTurnItemSchema },
  Interrupt: {},
  SwitchAgent: { agent: AgentName },
  InteractionResponded: { requestId: InteractionRequestId },
})
type LoopDriverEvent = Schema.Schema.Type<typeof LoopDriverEvent>

type LoopHandle = {
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  loopRef: SubscriptionRef.SubscriptionRef<AgentLoopState>
  sideMutationSemaphore: Semaphore.Semaphore
  queueMutationSemaphore: Semaphore.Semaphore
  persistenceFailure: Effect.Effect<void, AgentLoopError>
  resolveTurnProfile: Effect.Effect<{
    turnExtensionRegistry: ExtensionRegistryService
    turnDriverRegistry: DriverRegistryService
    turnExtensionRuntime: ExtensionRuntimeService
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

const interruptActiveStream = (activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>) =>
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

const causeToAgentLoopError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return Schema.is(AgentLoopError)(error)
    ? error
    : new AgentLoopError({
        message: "Agent loop turn failed",
        cause: error,
      })
}

const awaitIdleStateSince = (loop: LoopHandle, baseline: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(loop.loopRef)
    if (current.stateEpoch > baseline && current.state._tag === "Idle") return
    yield* SubscriptionRef.changes(loop.loopRef).pipe(
      Stream.filter((state) => state.stateEpoch > baseline && state.state._tag === "Idle"),
      Stream.runHead,
    )
  })

const failTurnFailureState = (failure: { readonly error: unknown }) =>
  Effect.fail(
    Schema.is(AgentLoopError)(failure.error)
      ? failure.error
      : new AgentLoopError({
          message: "Agent loop turn failed",
          cause: failure.error,
        }),
  )

const awaitTurnFailure = (
  loop: LoopHandle,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(loop.loopRef)
    if (current.turnFailure !== undefined && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
    const hasNewTurnFailure = (
      state: AgentLoopState,
    ): state is AgentLoopState & {
      readonly turnFailure: NonNullable<AgentLoopState["turnFailure"]>
    } => state.turnFailure !== undefined && state.turnFailure.epoch > baseline
    const next = yield* SubscriptionRef.changes(loop.loopRef).pipe(
      Stream.filter(hasNewTurnFailure),
      Stream.runHead,
    )
    if (Option.isSome(next)) return yield* failTurnFailureState(next.value.turnFailure)
    return yield* new AgentLoopError({
      message: "Agent loop turn failure stream ended",
    })
  })

const failIfTurnFailedSince = (
  loop: LoopHandle,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(loop.loopRef)
    if (current.turnFailure !== undefined && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
  })

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
  storage: StorageService
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
      const { queue: remainingQueue, nextItem } = takeNextQueuedTurn(queue)
      if (nextItem !== undefined) {
        yield* publishRecovery({ phase: "Idle", action: "resume-queued-turn" })
        return Option.some({
          state: buildRunningState(
            { currentAgent: state.currentAgent ?? params.currentAgent },
            nextItem,
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
      // The Running task will re-derive loop position from storage
      // (assistant message? tool results? → resume from correct point)
      yield* publishRecovery({ phase: "Running", action: "replay-running" })
      return Option.some({ state, queue })
    }

    if (state._tag === "WaitingForInteraction") {
      // Cold state — restore directly. Interaction re-publish happens via
      // InteractionStorage.listPending() in the server startup path.
      yield* publishRecovery({ phase: "WaitingForInteraction", action: "restore-cold" })
      return Option.some({ state, queue })
    }

    return Option.none()
  })

// Internal turn engine. Server-facing callers should go through SessionRuntime.

export interface AgentLoopService {
  readonly runOnce: (input: {
    sessionId: SessionId
    branchId: BranchId
    agentName: AgentNameType
    prompt: string
    interactive?: boolean
    runSpec?: RunSpec
  }) => Effect.Effect<void, AgentRunError>
  readonly submit: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      runSpec?: RunSpec
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly run: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      runSpec?: RunSpec
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, AgentLoopError>
  readonly drainQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly respondInteraction: (input: {
    sessionId: SessionId
    branchId: BranchId
    requestId: InteractionRequestId
  }) => Effect.Effect<void, AgentLoopError>
  readonly recordToolResult: (input: {
    commandId?: ActorCommandId
    sessionId: SessionId
    branchId: BranchId
    toolCallId: ToolCallId
    toolName: string
    output: unknown
    isError?: boolean
  }) => Effect.Effect<void, AgentLoopError>
  readonly invokeTool: (input: {
    commandId?: ActorCommandId
    sessionId: SessionId
    branchId: BranchId
    toolName: string
    input: unknown
  }) => Effect.Effect<void, AgentLoopError>
  readonly getState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<LoopRuntimeState, AgentLoopError>
  readonly watchState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<Stream.Stream<LoopRuntimeState>, AgentLoopError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void>
  readonly restoreSession: (sessionId: SessionId) => Effect.Effect<void>
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopService>()(
  "@gent/core/src/runtime/agent/agent-loop/AgentLoop",
) {
  static Live = (config: {
    baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<
    AgentLoop,
    never,
    | Storage
    | CheckpointStorage
    | Provider
    | ExtensionRegistry
    | DriverRegistry
    | ExtensionRuntime
    | ExtensionTurnControl
    | EventPublisher
    | ToolRunner
    | ResourceManager
    | ConfigService
    | ModelRegistry
    | ActorEngine
    | Receptionist
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const checkpointStorage = yield* CheckpointStorage
        const provider = yield* Provider
        const extensionRegistry = yield* ExtensionRegistry
        const driverRegistry = yield* DriverRegistry
        const extensionRuntime = yield* ExtensionRuntime
        const actorEngine = yield* ActorEngine
        const receptionist = yield* Receptionist
        const extensionTurnControl = yield* ExtensionTurnControl
        const eventPublisher = yield* EventPublisher
        const toolRunner = yield* ToolRunner
        const resourceManager = yield* ResourceManager
        // Yield ConfigService at setup so the captured service shape is
        // available to inner closures without leaking the requirement
        // into Stream/Machine task signatures.
        const configServiceForRun = yield* ConfigService
        // Capture ModelRegistry at setup so per-turn cost freezing (see
        // `computeStreamEndedCost`) is context-free on the hot path. The
        // pricing lookup stays an Effect so it can catch registry errors
        // without crossing into ProviderError.
        const modelRegistryForRun = yield* ModelRegistry
        const getPricing: PricingLookup = (modelId) =>
          modelRegistryForRun.get(modelId).pipe(
            Effect.map((m) => m?.pricing),
            Effect.catchEager(() => Effect.succeed(undefined)),
          )
        const loopsRef = yield* Ref.make<Map<string, LoopHandle>>(new Map())
        const mutationSemaphoresRef = yield* Ref.make<Map<string, Semaphore.Semaphore>>(new Map())
        const terminatedSessionsRef = yield* Ref.make<Set<SessionId>>(new Set())
        const loopsSemaphore = yield* Semaphore.make(1)
        const loopWatcherScope = yield* Scope.make()

        const stateKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

        const getMutationSemaphore = Effect.fn("AgentLoop.getMutationSemaphore")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const existing = (yield* Ref.get(mutationSemaphoresRef)).get(key)
          if (existing !== undefined) return existing

          const semaphore = yield* Semaphore.make(1)
          return yield* loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(mutationSemaphoresRef)).get(key)
              if (current !== undefined) return current
              yield* Ref.update(mutationSemaphoresRef, (semaphores) => {
                const next = new Map(semaphores)
                next.set(key, semaphore)
                return next
              })
              return semaphore
            }),
          )
        })

        const removeLoopIfCurrent = (
          sessionId: SessionId,
          branchId: BranchId,
          handle: LoopHandle,
        ) =>
          loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const key = stateKey(sessionId, branchId)
              yield* Ref.update(loopsRef, (loops) => {
                if (loops.get(key) !== handle) return loops
                const next = new Map(loops)
                next.delete(key)
                return next
              })
            }),
          )

        const closeLoopHandle = (handle: LoopHandle) =>
          Effect.gen(function* () {
            yield* interruptActiveStream(handle.activeStreamRef)
            yield* Deferred.succeed(handle.closed, undefined).pipe(Effect.ignore)
            yield* Scope.close(handle.scope, Exit.void)
          }).pipe(Effect.ignore)

        const cleanupLoopIfCurrent = (
          sessionId: SessionId,
          branchId: BranchId,
          handle: LoopHandle,
        ) =>
          removeLoopIfCurrent(sessionId, branchId, handle).pipe(
            Effect.andThen(closeLoopHandle(handle)),
            Effect.ignore,
          )

        const makeLoop = (
          sessionId: SessionId,
          branchId: BranchId,
          sideMutationSemaphore: Semaphore.Semaphore,
          initialQueue: LoopQueueState = emptyLoopQueueState(),
        ) =>
          Effect.gen(function* () {
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

            // SessionProfileCache remains genuinely optional here. All other
            // host defaults are now resolved through the ambient host helper.
            const sessionProfileCache = yield* Effect.serviceOption(SessionProfileCache)
            const permissionService = yield* Effect.serviceOption(Permission)

            const hostDeps = yield* makeAmbientExtensionHostContextDeps({
              extensionRuntime,
              extensionRegistry,
              storage,
              actorEngine,
              receptionist,
            })

            const profileCache =
              sessionProfileCache._tag === "Some" ? sessionProfileCache.value : undefined
            const defaultPermission =
              permissionService._tag === "Some" ? permissionService.value : AllowAllPermission

            /** Resolve a total per-turn environment: cwd → profile-backed services when present,
             *  otherwise server defaults. */
            const resolveTurnProfile = resolveSessionEnvironment({
              sessionId,
              branchId,
              storage,
              hostDeps,
              profileCache,
              defaults: {
                driverRegistry,
                permission: defaultPermission,
                baseSections: config.baseSections,
              },
            }).pipe(
              Effect.map(({ environment }) => ({
                turnExtensionRegistry: environment.extensionRegistry,
                turnDriverRegistry: environment.driverRegistry,
                turnExtensionRuntime: environment.extensionRuntime,
                turnPermission: environment.permission,
                turnBaseSections: environment.baseSections,
                turnHostCtx: environment.hostCtx,
              })),
            )

            const loopScope = yield* Scope.make()
            const activeStreamRef = yield* Ref.make<ActiveStreamHandle | undefined>(undefined)
            const turnMetricsRef = yield* Ref.make(emptyTurnMetrics())
            const interruptedRef = yield* Ref.make(false)
            const currentAgent = yield* resolveStoredAgent({ storage, sessionId, branchId })
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
              SubscriptionRef.modify(loopRef, (s) => {
                const { queue, nextItem } = takeNextQueuedTurn(s.queue)
                return [{ nextItem }, { ...s, queue }]
              }),
            )

            const switchAgentOnState = <S extends LoopState>(
              state: S,
              next: AgentNameType,
            ): Effect.Effect<S> =>
              Effect.gen(function* () {
                const previous = state.currentAgent ?? DEFAULT_AGENT_NAME
                if (previous === next) return state
                // Use per-session profile registry when available
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

            // The result of a single Running turn. The driver branches on this
            // to decide the next state transition (: replaces the FSM
            // event return previously consumed by `Machine.task`).
            const TurnOutcome = TaggedEnumClass("TurnOutcome", {
              Done: {},
              InteractionRequested: {
                pendingRequestId: InteractionRequestId,
                pendingToolCallId: Schema.String,
                currentTurnAgent: AgentName,
              },
            })
            type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

            // ── The inner agentic loop ──
            // resolve → stream → tools → repeat until LLM returns no tool calls
            const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
              yield* Ref.set(turnMetricsRef, emptyTurnMetrics())

              // Resolve per-turn environment before each model/tool step.
              const {
                turnExtensionRegistry,
                turnDriverRegistry,
                turnExtensionRuntime,
                turnPermission,
                turnBaseSections,
                turnHostCtx,
              } = yield* resolveTurnProfile

              let step = 0
              let interrupted = yield* Ref.get(interruptedRef)
              let streamFailed = false
              let currentTurnAgent: AgentNameType = state.currentAgent ?? DEFAULT_AGENT_NAME

              // Resume check: if assistant message with tool calls exists but no tool results,
              // we're resuming from WaitingForInteraction or crash. Execute tools first.
              // Resume always targets step 1 — interactions/crashes happen during the first tool execution.
              const resumeStep = 1
              const existingAssistant = yield* storage
                .getMessage(assistantMessageIdForTurn(state.message.id, resumeStep))
                .pipe(Effect.orElseSucceed(() => undefined))
              if (existingAssistant !== undefined && !interrupted) {
                const toolCalls = assistantDraftFromMessage(existingAssistant).toolCalls
                if (toolCalls.length > 0) {
                  const existingResults = yield* storage
                    .getMessage(toolResultMessageIdForTurn(state.message.id, resumeStep))
                    .pipe(Effect.orElseSucceed(() => undefined))
                  if (existingResults === undefined) {
                    // Resume tool execution (interaction response or crash recovery)
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
                      storage,
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
                    // Tools done — fall through to the loop which will resolve/stream the next step
                    step = 1
                  }
                  // If tool results already exist, the loop will re-resolve (picks them up from storage)
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

                // 1. Resolve
                // ConfigService is required by `resolveTurnContext` (driver
                // override resolution). Provided here from the captured
                // service so the surrounding Machine task signature stays
                // requirement-free.
                const resolved = yield* resolveTurnPhase({
                  message: state.message,
                  agentOverride: state.agentOverride,
                  runSpec: state.runSpec,
                  currentAgent: state.currentAgent,
                  storage,
                  branchId,
                  extensionRegistry: turnExtensionRegistry,
                  extensionRuntime: turnExtensionRuntime,
                  driverRegistry: turnDriverRegistry,
                  sessionId,
                  publishEvent: publishEventOrDie,
                  eventPublisher,
                  baseSections: turnBaseSections,
                  interactive: state.interactive,
                  hostCtx: turnHostCtx,
                }).pipe(
                  Effect.provideService(ConfigService, configServiceForRun),
                  Effect.provideService(ActorEngine, actorEngine),
                  Effect.provideService(Receptionist, receptionist),
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

                // 1b. Pre-turn hook
                yield* runTurnBeforeHook(
                  turnExtensionRegistry,
                  resolved,
                  sessionId,
                  branchId,
                  turnHostCtx,
                )

                // 2. Stream
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
                  storage,
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

                // External drivers own their own tool execution — tool-call
                // parts we collected are historical transcript, not pending work.
                if (collected.driverKind === "external") break

                // No tool calls → LLM is done
                const toolCalls = toolCallsFromResponseParts(collected.responseParts)
                if (toolCalls.length === 0) break

                // 3. Execute tools
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
                  storage,
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

                // Loop — tool results persisted, next resolve picks them up
              }

              // Finalize — TurnCompleted fires once per turn
              yield* finalizeTurnPhase({
                storage,
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

            // ── Plain-Effect driver (replaces effect-machine FSM) ──
            //
            // The previous FSM driver mediated state via `Machine.spawn`'s
            // event queue + transition table. With state already collapsed to
            // a single SubscriptionRef, the driver is now a switch on
            // `state._tag` inside each method. The per-turn fiber is forked
            // with `Effect.forkIn(loopScope)`; its completion runs the
            // post-turn transition (Done/Failed → drain queue, Interaction →
            // cold state) inline.

            // Persistence is invoked at every state mutation that the FSM
            // previously handled via `lifecycle.durability.save`. The
            // `persistenceFailure` deferred mirrors the FSM's failure
            // channel so state watchers can short-circuit;
            // the failure also propagates back through the dispatcher so
            // callers (e.g. `submit`) see the error directly — matching
            // the prior `actor.call(Event.Start)` semantics.
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

            // Forked per-turn fiber. Runs `runTurn`, then handles the outcome:
            //   Done             → next queued or Idle
            //   InteractionReq   → cold WaitingForInteraction
            //   Failure (cause)  → record failure, drain queue or Idle
            //
            // `sideMutationSemaphore` brackets the entire body. This matches
            // the FSM driver: `recordToolResult` / `invokeTool` and other
            // side-mutation dispatchers acquire the semaphore and therefore
            // wait for the active turn before applying. `Interrupt` is the
            // sole exception — it does NOT acquire the semaphore (see
            // `dispatch` below), so it can race the running turn the way
            // the FSM's actor event queue did.
            const runTurnFiber = (startState: RunningState): Effect.Effect<void, never> =>
              sideMutationSemaphore
                .withPermits(1)(
                  Effect.gen(function* () {
                    const outcome = yield* runTurn(startState).pipe(
                      Effect.annotateLogs({ sessionId, branchId }),
                      Effect.withSpan("AgentLoop.turn"),
                      Effect.tapCause((cause) =>
                        recordTurnFailure(cause).pipe(
                          Effect.andThen(
                            publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                          ),
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

                    // Done — drain queue or transition to Idle
                    const { nextItem } = yield* takeNextQueuedTurnSerialized
                    yield* Ref.set(interruptedRef, false)
                    if (nextItem !== undefined) {
                      const nextRunning = buildRunningState(
                        { currentAgent: startState.currentAgent },
                        nextItem,
                      )
                      yield* saveCheckpoint(nextRunning)
                      yield* forkTurn(nextRunning)
                      return
                    }
                    yield* saveCheckpoint(buildIdleState({ currentAgent: startState.currentAgent }))
                  }),
                )
                .pipe(
                  // Failure path mirrors the FSM's `onFailure: TurnFailed`:
                  // drain queue, replay if non-empty, otherwise Idle.
                  Effect.catchCause(() =>
                    sideMutationSemaphore.withPermits(1)(
                      Effect.gen(function* () {
                        const { nextItem } = yield* takeNextQueuedTurnSerialized
                        const current = yield* currentLoopState
                        yield* Ref.set(interruptedRef, false)
                        if (nextItem !== undefined) {
                          const nextRunning = buildRunningState(
                            { currentAgent: current.currentAgent },
                            nextItem,
                          )
                          yield* saveCheckpoint(nextRunning)
                          yield* forkTurn(nextRunning)
                          return
                        }
                        yield* saveCheckpoint(
                          buildIdleState({ currentAgent: current.currentAgent }),
                        )
                      }),
                    ),
                  ),
                  Effect.ignore,
                )

            const forkTurn = (startState: RunningState): Effect.Effect<void> =>
              Effect.forkIn(runTurnFiber(startState), loopScope).pipe(Effect.asVoid)

            // Public dispatch surface — replaces `actor.call(Event)` /
            // `actor.send(Event)`. Most events serialize via
            // `sideMutationSemaphore`. `Interrupt` for a running turn does
            // NOT acquire the semaphore — it must race the running turn,
            // mirroring the FSM driver where Interrupt was an event-queue
            // signal that ran independently of the in-flight `task`.
            const dispatch = (event: LoopDriverEvent): Effect.Effect<void, AgentLoopError> =>
              Effect.gen(function* () {
                if (event._tag === "Interrupt") {
                  // Race-safe: setting the flag + cancelling the stream are
                  // both single-step writes. The running turn observes the
                  // flag at its next checkpoint and exits.
                  const snap = yield* currentLoopState
                  if (snap._tag === "Idle") return
                  if (snap._tag === "Running") {
                    yield* Ref.set(interruptedRef, true)
                    yield* interruptActiveStream(activeStreamRef)
                    return
                  }
                  // WaitingForInteraction → Running with interrupt flag.
                  // The forked turn re-enters runTurn at step 0 and exits
                  // immediately because `interruptedRef === true`. State
                  // transition still needs the semaphore.
                  yield* sideMutationSemaphore.withPermits(1)(
                    Effect.gen(function* () {
                      const state = yield* currentLoopState
                      if (state._tag !== "WaitingForInteraction") return
                      yield* Ref.set(interruptedRef, true)
                      // Preserve `startedAtMs` so turn-duration metrics
                      // include time spent in WaitingForInteraction —
                      // matches FSM-era semantics.
                      const resumed = buildRunningState(
                        { currentAgent: state.currentAgent },
                        {
                          message: state.message,
                          ...(state.agentOverride !== undefined
                            ? { agentOverride: state.agentOverride }
                            : {}),
                          ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
                          ...(state.interactive !== undefined
                            ? { interactive: state.interactive }
                            : {}),
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
                        // Clear stale interrupt before forking — prevents a stray
                        // Interrupt that latched after the prior turn ended from
                        // aborting this fresh turn.
                        yield* Ref.set(interruptedRef, false)
                        const next = buildRunningState(state, event.item)
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
                        // Clear stale interrupt before resuming the suspended turn.
                        yield* Ref.set(interruptedRef, false)
                        // Preserve `startedAtMs` so turn-duration metrics
                        // include time spent in WaitingForInteraction —
                        // matches FSM-era semantics.
                        const resumed = buildRunningState(
                          { currentAgent: state.currentAgent },
                          {
                            message: state.message,
                            ...(state.agentOverride !== undefined
                              ? { agentOverride: state.agentOverride }
                              : {}),
                            ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
                            ...(state.interactive !== undefined
                              ? { interactive: state.interactive }
                              : {}),
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

            const publishRecoveryAbandoned = (params: {
              reason: RecoveryAbandonReason
              detail?: string
            }) =>
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

            // Recovery + initial fork. Replaces `Machine.spawn`'s
            // `lifecycle.recovery.resolve` + auto-start. Idempotent — guarded
            // by `started`.
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
                storage,
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

        const getLoop = Effect.fn("AgentLoop.getLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const sideMutationSemaphore = yield* getMutationSemaphore(sessionId, branchId)
          // Allocate + register under semaphore, then run `start` outside.
          // The plain-Effect driver does not auto-fork its turn fiber until
          // `start` is invoked, so the handle must be installed in loopsRef
          // before recovery runs — otherwise a recovered Running turn would
          // re-enter getLoop and deadlock waiting on the same semaphore.
          const created = yield* Effect.withSpan("AgentLoop.getLoop.semaphore")(
            loopsSemaphore.withPermits(1)(
              Effect.gen(function* () {
                if ((yield* Ref.get(terminatedSessionsRef)).has(sessionId)) {
                  return yield* new AgentLoopError({
                    message: `Session runtime terminated: ${sessionId}`,
                  })
                }
                const existing = (yield* Ref.get(loopsRef)).get(key)
                if (existing !== undefined) return undefined
                const handle = yield* makeLoop(sessionId, branchId, sideMutationSemaphore)
                yield* Ref.update(loopsRef, (loops) => {
                  const next = new Map(loops)
                  next.set(key, handle)
                  return next
                })
                return handle
              }),
            ),
          )
          if (created !== undefined) {
            yield* Effect.gen(function* () {
              yield* created.start
              if (yield* Deferred.isDone(created.closed)) {
                return yield* new AgentLoopError({
                  message: `Session runtime terminated: ${sessionId}`,
                })
              }
              yield* created.refreshRuntimeState
              yield* Effect.forkIn(
                created.awaitExit.pipe(
                  Effect.flatMap(() => cleanupLoopIfCurrent(sessionId, branchId, created)),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("agent-loop.exit-cleanup failed").pipe(
                      Effect.annotateLogs({ error: Cause.pretty(cause) }),
                    ),
                  ),
                ),
                loopWatcherScope,
              )
            }).pipe(
              Effect.catchEager((error) =>
                cleanupLoopIfCurrent(sessionId, branchId, created).pipe(
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            )
            return created
          }
          // Handle was installed by another fiber — guaranteed to exist
          // since the semaphore serializes creation for the same key.
          const loops = yield* Ref.get(loopsRef)
          const existing = loops.get(key)
          if (existing === undefined) {
            return yield* Effect.die(new Error(`Loop handle missing for ${key} after creation`))
          }
          return existing
        })

        const findLoop = Effect.fn("AgentLoop.findLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const loops = yield* Ref.get(loopsRef)
          return loops.get(key)
        })

        const publishRecoveryProbeAbandoned = (
          sessionId: SessionId,
          branchId: BranchId,
          reason: RecoveryAbandonReason,
          detail: string,
        ) =>
          eventPublisher
            .publish(
              AgentLoopRecoveryAbandoned.make({
                sessionId,
                branchId,
                reason,
                detail,
              }),
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new AgentLoopError({
                    message: "Failed to publish AgentLoopRecoveryAbandoned",
                    cause: error,
                  }),
              ),
            )

        const findOrRestoreLoop = Effect.fn("AgentLoop.findOrRestoreLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          if ((yield* Ref.get(terminatedSessionsRef)).has(sessionId)) return undefined
          const existing = yield* findLoop(sessionId, branchId)
          if (existing !== undefined) return existing

          const checkpoint = Option.getOrUndefined(
            yield* checkpointStorage.get({ sessionId, branchId }).pipe(
              Effect.map((record) => (record === undefined ? Option.none() : Option.some(record))),
              Effect.catchCause((cause) =>
                publishRecoveryProbeAbandoned(
                  sessionId,
                  branchId,
                  "checkpoint-read-failed",
                  Cause.pretty(cause),
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new AgentLoopError({
                        message: "Failed to read agent loop checkpoint",
                        cause: Cause.squash(cause),
                      }),
                    ),
                  ),
                ),
              ),
            ),
          )
          if (checkpoint === undefined) return undefined

          return yield* getLoop(sessionId, branchId)
        })

        const buildQueuedTurnItem = (
          command: SubmitTurnCommand | RunTurnCommand,
        ): QueuedTurnItem => ({
          message: command.message,
          ...(command.agentOverride !== undefined ? { agentOverride: command.agentOverride } : {}),
          ...(command.runSpec !== undefined ? { runSpec: command.runSpec } : {}),
          ...(command.interactive !== undefined ? { interactive: command.interactive } : {}),
        })

        const currentRuntimeState = (loop: LoopHandle) =>
          SubscriptionRef.get(loop.loopRef).pipe(Effect.map(projectRuntimeState))

        const terminateSession = Effect.fn("AgentLoop.terminateSession")(function* (
          sessionId: SessionId,
        ) {
          const prefix = `${sessionId}:`
          const loopsToClose = yield* loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(terminatedSessionsRef, (terminated) => {
                const next = new Set(terminated)
                next.add(sessionId)
                return next
              })

              const selected = Array.from((yield* Ref.get(loopsRef)).entries()).filter(([key]) =>
                key.startsWith(prefix),
              )
              yield* Ref.update(loopsRef, (loops) => {
                const next = new Map(loops)
                for (const [key] of selected) {
                  next.delete(key)
                }
                return next
              })
              yield* Ref.update(mutationSemaphoresRef, (semaphores) => {
                const next = new Map(semaphores)
                for (const key of next.keys()) {
                  if (key.startsWith(prefix)) next.delete(key)
                }
                return next
              })
              return selected.map(([, loop]) => loop)
            }),
          )

          yield* Effect.forEach(loopsToClose, closeLoopHandle, {
            concurrency: "unbounded",
            discard: true,
          })
        })

        const restoreSession = Effect.fn("AgentLoop.restoreSession")(function* (
          sessionId: SessionId,
        ) {
          yield* loopsSemaphore.withPermits(1)(
            Ref.update(terminatedSessionsRef, (terminated) => {
              if (!terminated.has(sessionId)) return terminated
              const next = new Set(terminated)
              next.delete(sessionId)
              return next
            }),
          )
        })

        const turnControlOwnerFor = (
          loop: LoopHandle,
          sessionId: SessionId,
          branchId: BranchId,
          stateForQueuePersistence?: LoopState,
        ): CurrentTurnControlOwnerService => ({
          matches: (command) => command.sessionId === sessionId && command.branchId === branchId,
          apply: (command) =>
            Effect.gen(function* () {
              if (command.sessionId !== sessionId || command.branchId !== branchId) {
                return false
              }
              switch (command._tag) {
                case "QueueFollowUp": {
                  const message = Message.Regular.make({
                    id: MessageId.make(Bun.randomUUIDv7()),
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    role: "user",
                    parts: [new TextPart({ type: "text", text: command.content })],
                    createdAt: yield* DateTime.nowAsDate,
                    metadata: command.metadata,
                  })
                  const currentQueue = yield* SubscriptionRef.get(loop.loopRef).pipe(
                    Effect.map((s) => s.queue),
                  )
                  if (countQueuedFollowUps(currentQueue) >= DEFAULTS.followUpQueueMax) {
                    return yield* new TurnControlError({
                      command: command._tag,
                      message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                    })
                  }
                  const nextQueue = appendFollowUpQueueState(currentQueue, { message })
                  const persist =
                    stateForQueuePersistence === undefined
                      ? loop.persistQueueState(nextQueue)
                      : loop.persistQueueSnapshot(stateForQueuePersistence, nextQueue)
                  yield* persist.pipe(
                    Effect.mapError(
                      (cause) =>
                        new TurnControlError({
                          command: command._tag,
                          message: `Failed to apply ${command._tag} turn-control command`,
                          cause,
                        }),
                    ),
                  )
                  return true
                }
                case "Interject": {
                  const message = Message.Interjection.make({
                    id: MessageId.make(Bun.randomUUIDv7()),
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    role: "user",
                    parts: [new TextPart({ type: "text", text: command.content })],
                    createdAt: yield* DateTime.nowAsDate,
                  })
                  const nextQueue = appendSteeringItem(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    { message },
                  )
                  const persist =
                    stateForQueuePersistence === undefined
                      ? loop.persistQueueState(nextQueue)
                      : loop.persistQueueSnapshot(stateForQueuePersistence, nextQueue)
                  yield* persist.pipe(
                    Effect.mapError(
                      (cause) =>
                        new TurnControlError({
                          command: command._tag,
                          message: `Failed to apply ${command._tag} turn-control command`,
                          cause,
                        }),
                    ),
                  )
                  const state = stateForQueuePersistence ?? (yield* currentRuntimeState(loop))
                  if (state._tag === "Running" && stateForQueuePersistence === undefined) {
                    yield* interruptActiveStream(loop.activeStreamRef)
                  }
                  return true
                }
              }
            }),
        })

        const withQueueMutationOwner = <A, E, R>(
          loop: LoopHandle,
          sessionId: SessionId,
          branchId: BranchId,
          effect: Effect.Effect<A, E, R>,
          stateForQueuePersistence?: LoopState,
        ): Effect.Effect<A, E, R> =>
          extensionTurnControl.withOwner(
            turnControlOwnerFor(loop, sessionId, branchId, stateForQueuePersistence),
            effect,
          )

        const submitTurn = Effect.fn("AgentLoop.submitTurn")(function* (
          command: SubmitTurnCommand,
        ) {
          const loop = yield* getLoop(command.message.sessionId, command.message.branchId)
          const item = buildQueuedTurnItem(command)
          const reservedStart = yield* withQueueMutationOwner(
            loop,
            command.message.sessionId,
            command.message.branchId,
            loop.queueMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const startingState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.startingState),
                )
                if (startingState !== undefined) {
                  yield* loop.persistQueueSnapshot(
                    startingState,
                    appendFollowUpQueueState(
                      yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                      item,
                    ),
                  )
                  return
                }
                const projectedState = yield* currentRuntimeState(loop)
                if (projectedState._tag !== "Idle") {
                  const nextQueue = appendFollowUpQueueState(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    item,
                  )
                  yield* loop.persistQueueCurrentState(nextQueue)
                  return
                }
                const loopState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.state),
                )
                if (loopState._tag !== "Idle") {
                  const nextQueue = appendFollowUpQueueState(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    item,
                  )
                  yield* loop.persistQueueCurrentState(nextQueue)
                  return
                }

                const reservedRunningState = buildRunningState(loopState, item)
                yield* SubscriptionRef.update(loop.loopRef, (s) => ({
                  ...s,
                  startingState: reservedRunningState,
                }))
                return reservedRunningState
              }),
            ),
          )
          if (reservedStart !== undefined) {
            yield* loop
              .dispatch(LoopDriverEvent.Start.make({ item }))
              .pipe(
                Effect.catchEager((error) =>
                  cleanupLoopIfCurrent(
                    command.message.sessionId,
                    command.message.branchId,
                    loop,
                  ).pipe(Effect.andThen(Effect.fail(error))),
                ),
              )
          }
        })

        const runTurn = Effect.fn("AgentLoop.runTurn")(function* (command: RunTurnCommand) {
          const loop = yield* getLoop(command.message.sessionId, command.message.branchId)
          const item = buildQueuedTurnItem(command)
          const start = yield* loop.queueMutationSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const initialState = yield* loop.snapshot
              if (initialState._tag !== "Idle") {
                const nextQueue = appendFollowUpQueueState(
                  yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                  item,
                )
                yield* loop.persistQueueState(nextQueue)
                return undefined
              }
              const current = yield* SubscriptionRef.get(loop.loopRef)
              return {
                stateEpochBaseline: current.stateEpoch,
                turnFailureBaseline: current.turnFailure?.epoch ?? 0,
              }
            }),
          )
          if (start === undefined) {
            return
          }
          yield* loop
            .dispatch(LoopDriverEvent.Start.make({ item }))
            .pipe(
              Effect.catchEager((error) =>
                cleanupLoopIfCurrent(
                  command.message.sessionId,
                  command.message.branchId,
                  loop,
                ).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )

          yield* Effect.raceFirst(
            Effect.raceFirst(
              awaitIdleStateSince(loop, start.stateEpochBaseline),
              awaitTurnFailure(loop, start.turnFailureBaseline),
            ),
            loop.persistenceFailure,
          ).pipe(
            Effect.catchEager((error) =>
              cleanupLoopIfCurrent(command.message.sessionId, command.message.branchId, loop).pipe(
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          )
          yield* failIfTurnFailedSince(loop, start.turnFailureBaseline)
        })

        const applySteer = Effect.fn("AgentLoop.applySteer")(function* (
          command: ApplySteerCommand,
        ) {
          const loop = yield* getLoop(command.command.sessionId, command.command.branchId)
          const projectedState = yield* currentRuntimeState(loop)

          const wrapDispatch = (event: LoopDriverEvent) =>
            loop
              .dispatch(event)
              .pipe(
                Effect.catchEager((error) =>
                  cleanupLoopIfCurrent(
                    command.command.sessionId,
                    command.command.branchId,
                    loop,
                  ).pipe(Effect.andThen(Effect.fail(error))),
                ),
              )

          switch (command.command._tag) {
            case "SwitchAgent":
              yield* wrapDispatch(
                LoopDriverEvent.SwitchAgent.make({ agent: command.command.agent }),
              )
              return

            case "Cancel":
            case "Interrupt":
              if (
                projectedState._tag === "Running" ||
                projectedState._tag === "WaitingForInteraction"
              ) {
                yield* wrapDispatch(LoopDriverEvent.Interrupt.make({}))
                return
              }
              const loopState = yield* loop.snapshot
              if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
                yield* wrapDispatch(LoopDriverEvent.Interrupt.make({}))
              }
              return

            case "Interject": {
              const interjectMessage = Message.Interjection.make({
                id: MessageId.make(Bun.randomUUIDv7()),
                sessionId: command.command.sessionId,
                branchId: command.command.branchId,
                role: "user",
                parts: [new TextPart({ type: "text", text: command.command.message })],
                createdAt: yield* DateTime.nowAsDate,
              })
              const item: QueuedTurnItem = {
                message: interjectMessage,
                ...(command.command.agent !== undefined
                  ? { agentOverride: command.command.agent }
                  : {}),
              }
              const shouldInterrupt = yield* loop.queueMutationSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  const nextQueue = appendSteeringItem(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    item,
                  )
                  yield* loop.persistQueueState(nextQueue)
                  const loopState = yield* loop.snapshot
                  return projectedState._tag === "Running" || loopState._tag === "Running"
                }),
              )
              if (shouldInterrupt) {
                yield* interruptActiveStream(loop.activeStreamRef)
              }
              return
            }
          }
        })

        const respondInteraction = Effect.fn("AgentLoop.respondInteraction")(function* (
          command: RespondInteractionCommand,
        ) {
          const loop = yield* findOrRestoreLoop(command.sessionId, command.branchId)
          if (loop === undefined) return
          const projectedState = yield* currentRuntimeState(loop)
          if (projectedState._tag !== "WaitingForInteraction") {
            const state = yield* loop.snapshot
            if (state._tag !== "WaitingForInteraction") return
          }
          yield* loop
            .dispatch(LoopDriverEvent.InteractionResponded.make({ requestId: command.requestId }))
            .pipe(
              Effect.catchEager((error) =>
                cleanupLoopIfCurrent(command.sessionId, command.branchId, loop).pipe(
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            )
        })

        const recordToolResult = Effect.fn("AgentLoop.recordToolResultPhase")(function* (
          command: RecordToolResultCommand,
        ) {
          const mutationSemaphore = yield* getMutationSemaphore(command.sessionId, command.branchId)
          yield* mutationSemaphore
            .withPermits(1)(
              Effect.gen(function* () {
                yield* getLoop(command.sessionId, command.branchId)
                yield* recordToolResultPhase({
                  storage,
                  eventPublisher,
                  commandId: command.commandId ?? makeCommandId(),
                  sessionId: command.sessionId,
                  branchId: command.branchId,
                  toolCallId: command.toolCallId,
                  toolName: command.toolName,
                  output: command.output,
                  ...(command.isError !== undefined ? { isError: command.isError } : {}),
                })
              }),
            )
            .pipe(Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))))
        })

        const invokeTool = Effect.fn("AgentLoop.invokeToolPhase")(function* (
          command: InvokeToolCommand,
        ) {
          const mutationSemaphore = yield* getMutationSemaphore(command.sessionId, command.branchId)
          yield* mutationSemaphore
            .withPermits(1)(
              Effect.gen(function* () {
                const loop = yield* getLoop(command.sessionId, command.branchId)
                const commandId = command.commandId ?? makeCommandId()
                const currentTurnAgent = (yield* currentRuntimeState(loop)).agent
                const environment = yield* loop.resolveTurnProfile

                yield* invokeToolPhase({
                  assistantMessageId: assistantMessageIdForCommand(commandId),
                  toolResultMessageId: toolResultMessageIdForCommand(commandId),
                  toolCallId: toolCallIdForCommand(commandId),
                  toolName: command.toolName,
                  input: command.input,
                  publishEvent: (event) =>
                    eventPublisher.publish(event).pipe(Effect.catchEager(() => Effect.void)),
                  eventPublisher,
                  sessionId: command.sessionId,
                  branchId: command.branchId,
                  currentTurnAgent,
                  toolRunner,
                  extensionRegistry: environment.turnExtensionRegistry,
                  permission: environment.turnPermission,
                  hostCtx: environment.turnHostCtx,
                  resourceManager,
                  storage,
                })
              }),
            )
            .pipe(Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))))
        })

        const dispatchLoopCommand = Effect.fn("AgentLoop.dispatchLoopCommand")(function* (
          command: LoopCommand,
        ) {
          switch (command._tag) {
            case "SubmitTurn":
              return yield* submitTurn(command)

            case "RunTurn":
              return yield* runTurn(command)

            case "ApplySteer":
              return yield* applySteer(command)

            case "RespondInteraction":
              return yield* respondInteraction(command)

            case "RecordToolResult":
              return yield* recordToolResult(command)

            case "InvokeTool":
              return yield* invokeTool(command)
          }
        })

        const enqueueFollowUp = Effect.fn("AgentLoop.enqueueFollowUp")(function* (
          message: Message,
        ) {
          const existingLoop = yield* findLoop(message.sessionId, message.branchId)
          const loop = existingLoop ?? (yield* getLoop(message.sessionId, message.branchId))
          const item = { message }
          const reservedStart = yield* withQueueMutationOwner(
            loop,
            message.sessionId,
            message.branchId,
            loop.queueMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const currentQueue = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.queue),
                )
                if (countQueuedFollowUps(currentQueue) >= DEFAULTS.followUpQueueMax) {
                  return yield* new AgentLoopError({
                    message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                  })
                }
                if (existingLoop === undefined) {
                  yield* loop.persistQueueState(appendFollowUpQueueState(currentQueue, item))
                  return
                }
                const projectedState = yield* currentRuntimeState(loop)
                const startingState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.startingState),
                )
                if (startingState !== undefined) {
                  yield* loop.persistQueueSnapshot(
                    startingState,
                    appendFollowUpQueueState(currentQueue, item),
                  )
                  return
                }
                if (projectedState._tag !== "Idle") {
                  yield* loop.persistQueueCurrentState(appendFollowUpQueueState(currentQueue, item))
                  return
                }
                const loopState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.state),
                )
                if (loopState._tag !== "Idle") {
                  yield* loop.persistQueueCurrentState(appendFollowUpQueueState(currentQueue, item))
                  return
                }
                const reservedRunningState = buildRunningState(loopState, item)
                yield* SubscriptionRef.update(loop.loopRef, (s) => ({
                  ...s,
                  startingState: reservedRunningState,
                }))
                return reservedRunningState
              }),
            ),
          )
          if (reservedStart !== undefined) {
            yield* loop
              .dispatch(LoopDriverEvent.Start.make({ item }))
              .pipe(
                Effect.catchEager((error) =>
                  cleanupLoopIfCurrent(message.sessionId, message.branchId, loop).pipe(
                    Effect.andThen(Effect.fail(error)),
                  ),
                ),
              )
          }
        })

        const service: AgentLoopService = {
          runOnce: Effect.fn("AgentLoop.runOnce")(function* (input) {
            const userMessage = Message.Regular.make({
              id: MessageId.make(Bun.randomUUIDv7()),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.prompt })],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* persistMessageReceived({
              storage,
              eventPublisher,
              message: userMessage,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentRunError({
                    message: `Failed to persist user message for ${input.sessionId}`,
                    cause,
                  }),
              ),
            )

            return yield* service
              .run(userMessage, {
                agentOverride: input.agentName,
                ...(input.runSpec !== undefined ? { runSpec: input.runSpec } : {}),
                ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentRunError({
                      message: cause.message,
                      cause,
                    }),
                ),
              )
          }),

          submit: Effect.fn("AgentLoop.submit")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              runSpec?: RunSpec
              interactive?: boolean
            },
          ) {
            return yield* dispatchLoopCommand({
              _tag: "SubmitTurn",
              message,
              ...(options?.agentOverride !== undefined
                ? { agentOverride: options.agentOverride }
                : {}),
              ...(options?.runSpec !== undefined ? { runSpec: options.runSpec } : {}),
              ...(options?.interactive !== undefined ? { interactive: options.interactive } : {}),
            })
          }),

          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              runSpec?: RunSpec
              interactive?: boolean
            },
          ) {
            return yield* dispatchLoopCommand({
              _tag: "RunTurn",
              message,
              ...(options?.agentOverride !== undefined
                ? { agentOverride: options.agentOverride }
                : {}),
              ...(options?.runSpec !== undefined ? { runSpec: options.runSpec } : {}),
              ...(options?.interactive !== undefined ? { interactive: options.interactive } : {}),
            })
          }),

          steer: (command) => dispatchLoopCommand({ _tag: "ApplySteer", command }),

          drainQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                const terminated = yield* Ref.get(terminatedSessionsRef)
                if (terminated.has(input.sessionId)) {
                  return yield* new AgentLoopError({
                    message: `Session terminated: ${input.sessionId}`,
                  })
                }
                return queueSnapshotFromQueueState(emptyLoopQueueState())
              }

              return yield* loop.queueMutationSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  const queue = yield* SubscriptionRef.get(loop.loopRef).pipe(
                    Effect.map((s) => s.queue),
                  )
                  const snapshot = queueSnapshotFromQueueState(queue)
                  yield* loop.persistQueueState(emptyLoopQueueState())
                  return snapshot
                }),
              )
            }),

          getQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                const terminated = yield* Ref.get(terminatedSessionsRef)
                if (terminated.has(input.sessionId)) {
                  return yield* new AgentLoopError({
                    message: `Session terminated: ${input.sessionId}`,
                  })
                }
                return queueSnapshotFromQueueState(emptyLoopQueueState())
              }

              return yield* loop.queueMutationSemaphore.withPermits(1)(
                SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => queueSnapshotFromQueueState(s.queue)),
                ),
              )
            }),

          respondInteraction: (input) =>
            dispatchLoopCommand({ _tag: "RespondInteraction", ...input }),

          recordToolResult: (input) => dispatchLoopCommand({ _tag: "RecordToolResult", ...input }),

          invokeTool: (input) => dispatchLoopCommand({ _tag: "InvokeTool", ...input }),

          getState: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop !== undefined) {
                const state = yield* loop.queueMutationSemaphore.withPermits(1)(
                  SubscriptionRef.get(loop.loopRef).pipe(Effect.map(projectRuntimeState)),
                )
                return state
              }

              // No running loop. Before synthesizing an idle state from
              // persisted events, confirm the session wasn't terminated — the
              // terminated set outlives `closeLoopHandle` and catches the
              // check-then-use race where delete lands between the caller's
              // `requireSessionExists` gate and this fallback.
              const terminated = yield* Ref.get(terminatedSessionsRef)
              if (terminated.has(input.sessionId)) {
                return yield* new AgentLoopError({
                  message: `Session terminated: ${input.sessionId}`,
                })
              }

              return runtimeStateFromLoopState(
                buildIdleState({
                  currentAgent: yield* resolveStoredAgent({
                    storage,
                    sessionId: input.sessionId,
                    branchId: input.branchId,
                  }),
                }),
                emptyLoopQueueState(),
              )
            }),
          watchState: (input) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(input.sessionId, input.branchId)
              return SubscriptionRef.changes(loop.loopRef).pipe(
                Stream.map(projectRuntimeState),
                Stream.interruptWhen(Deferred.await(loop.closed)),
              )
            }),

          terminateSession,
          restoreSession,
        }

        const failTurnControlCommand = (
          command: TurnControlEnvelope,
          cause: Cause.Cause<unknown>,
        ) =>
          Deferred.fail(
            command.ack,
            new TurnControlError({
              command: command._tag,
              message: `Failed to apply ${command._tag} turn-control command`,
              cause: Cause.squash(cause),
            }),
          ).pipe(Effect.asVoid)

        yield* Stream.runForEach(extensionTurnControl.commands, (command) =>
          Effect.gen(function* () {
            const applied = yield* Effect.exit(
              Effect.gen(function* () {
                switch (command._tag) {
                  case "QueueFollowUp": {
                    const message = Message.Regular.make({
                      id: MessageId.make(Bun.randomUUIDv7()),
                      sessionId: command.sessionId,
                      branchId: command.branchId,
                      role: "user",
                      parts: [new TextPart({ type: "text", text: command.content })],
                      createdAt: yield* DateTime.nowAsDate,
                      metadata: command.metadata,
                    })
                    yield* enqueueFollowUp(message)
                    return
                  }
                  case "Interject":
                    yield* service.steer({
                      _tag: "Interject",
                      sessionId: command.sessionId,
                      branchId: command.branchId,
                      message: command.content,
                    })
                    return
                }
              }),
            )
            if (applied._tag === "Success") {
              yield* Deferred.succeed(command.ack, undefined).pipe(Effect.asVoid)
              return
            }
            yield* failTurnControlCommand(command, applied.cause)
          }),
        ).pipe(Effect.forkScoped)

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const loops = yield* Ref.get(loopsRef)
            yield* Effect.forEach(Array.from(loops.values()), closeLoopHandle, {
              concurrency: "unbounded",
            })
            yield* Scope.close(loopWatcherScope, Exit.void)
          }),
        )

        return service
      }),
    )

  static Test = (): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      runOnce: () => Effect.void,
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      drainQueue: () => Effect.succeed(emptyQueueSnapshot()),
      getQueue: () => Effect.succeed(emptyQueueSnapshot()),
      respondInteraction: () => Effect.void,
      recordToolResult: () => Effect.void,
      invokeTool: () => Effect.void,
      terminateSession: () => Effect.void,
      restoreSession: () => Effect.void,
      getState: () =>
        Effect.succeed(
          LoopRuntimeStateSchema.Idle.make({
            agent: DEFAULT_AGENT_NAME,
            queue: emptyQueueSnapshot(),
          }),
        ),
      watchState: () => Effect.succeed(Stream.empty),
    })
}
