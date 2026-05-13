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
  Context,
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
import { AgentSwitched, type AgentEvent } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import type { MessageMetadata } from "../../domain/message.js"
import type { BranchId, InteractionRequestId, SessionId } from "../../domain/ids.js"
import { makeAmbientExtensionHostContextProvider } from "../make-extension-host-context.js"
import type { ConfigService } from "../config-service.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { StorageError } from "../../domain/storage-error.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import type { MessageStorage } from "../../storage/message-storage.js"
import type { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import { SessionProfileCache } from "../session-profile.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { makeExtensionHostPlatform } from "../extensions/host-platform.js"
import { ToolRunner } from "./tool-runner.js"
import type { ModelRegistry } from "../model-registry.js"
import type { GentPlatform } from "../gent-platform.js"
import { Permission } from "../../domain/permission.js"
import {
  AllowAllPermission,
  resolveSessionEnvironment,
  SessionEnvironmentHostProvider,
} from "../session-runtime-context.js"
import {
  buildIdleState,
  emptyLoopQueueState,
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
import { emptyTurnMetrics, type ActiveStreamHandle } from "./turn-response.js"
import { AgentLoopQueueScope, makeAgentLoopQueue } from "./agent-loop.queue.js"
import {
  AgentLoopTurnExecutionScope,
  makeAgentLoopTurnExecution,
} from "./agent-loop.turn-execution.js"
import { AgentLoopWorkerScope, makeAgentLoopWorker } from "./agent-loop.worker.js"
import type { AgentLoopTurnProfile } from "./agent-loop.turn-profile.js"

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
  resolveTurnProfile: Effect.Effect<AgentLoopTurnProfile>
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

export interface AgentLoopFollowUpService {
  readonly enqueue: EnqueueFollowUp
}

export class AgentLoopFollowUp extends Context.Service<
  AgentLoopFollowUp,
  AgentLoopFollowUpService
>()("@gent/core/src/runtime/agent/agent-loop.behavior/AgentLoopFollowUp") {}

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
  | AgentLoopFollowUp
  | ConfigService
  | ModelRegistry
  | ChildProcessSpawner
  | GentPlatform
> =>
  Effect.gen(function* () {
    yield* ModelResolver
    const extensionRegistry = yield* ExtensionRegistry
    const driverRegistry = yield* DriverRegistry
    const eventPublisher = yield* EventPublisher
    yield* ToolRunner
    const followUp = yield* AgentLoopFollowUp
    const host = yield* makeExtensionHostPlatform
    // Snapshot the layer-build context so behavior methods (declared as
    // `Effect<A, E, never>` in `AgentLoopBehavior`) can resolve Tags that
    // Turn helper modules now yield inside (post-W33-C3.3). Without this, helper
    // requirements like `MessageStorage`, `EventPublisher`, `SqlClient`,
    // `ModelResolver`, `ModelRegistry`, `ToolRunner`, etc. leak into the
    // method R-channels and break the interface.
    const runtimeContext = yield* Effect.context<
      | SessionStorage
      | MessageStorage
      | EventStorage
      | SqlClient.SqlClient
      | ModelResolver
      | ModelRegistry
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
        | ModelRegistry
        | ToolRunner
        | EventPublisher
      >
    > => Effect.provideContext(effect, runtimeContext)

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
    const sessionProfileCache = yield* Effect.serviceOption(SessionProfileCache)
    const permissionService = yield* Effect.serviceOption(Permission)

    const hostProvider = yield* makeAmbientExtensionHostContextProvider({
      extensionRegistry,
      overrides: {
        host,
        sessionControl: {
          queueFollowUp: (input): Effect.Effect<void, AgentLoopError | StorageError> =>
            followUp.enqueue(input),
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
        profileCache,
        defaults: {
          driverRegistry,
          permission: defaultPermission,
          baseSections,
        },
      }).pipe(Effect.provideService(SessionEnvironmentHostProvider, hostProvider)),
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

    const queue = yield* makeAgentLoopQueue.pipe(
      Effect.provideService(AgentLoopQueueScope, {
        sessionId,
        branchId,
        loopRef,
        queuePersistenceSemaphore,
        persistenceFailure,
        startedRef,
      }),
    )

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
        const agents = [...switchRegistry.getResolved().agents.values()]
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

    const { runTurn } = yield* makeAgentLoopTurnExecution.pipe(
      Effect.provideService(AgentLoopTurnExecutionScope, {
        sessionId,
        branchId,
        resolveTurnProfile,
        activeStreamRef,
        turnMetricsRef,
        interruptedRef,
        clearInFlightTurn,
      }),
    )

    const worker = yield* makeAgentLoopWorker.pipe(
      Effect.provideService(AgentLoopWorkerScope, {
        sessionId,
        branchId,
        sideMutationSemaphore,
        turnWorkerQueue,
        activeStreamRef,
        interruptedRef,
        currentLoopState,
        saveCheckpoint,
        takeNextQueuedTurn: takeNextQueuedTurnCommitted,
        recordTurnFailure,
        publishEvent,
        runTurn,
        switchAgentOnState,
      }),
    )

    const startTurnWorker = Effect.forkIn(provideRuntime(worker.turnWorkerLoop), loopScope, {
      startImmediately: true,
    }).pipe(Effect.asVoid)

    const start = Effect.gen(function* () {
      if (yield* Ref.getAndSet(startedRef, true)) return
      yield* startTurnWorker
    }).pipe(Effect.withSpan("AgentLoop.start"))

    const close = Effect.gen(function* () {
      yield* worker.interruptActiveStream
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
      startTurn: worker.startTurn,
      interruptActiveStream: worker.interruptActiveStream,
      interrupt: worker.interrupt,
      switchAgent: worker.switchAgent,
      respondInteraction: worker.respondInteraction,
      withSideMutation: worker.withSideMutation,
      start,
      awaitExit: Deferred.await(closed),
      close,
    } satisfies AgentLoopBehavior
  })
