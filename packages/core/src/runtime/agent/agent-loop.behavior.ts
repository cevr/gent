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
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Semaphore,
  Scope,
  TxQueue,
  TxSubscriptionRef,
  type Stream,
  type FileSystem,
  type Path,
} from "effect"
import { Entity, Sharding } from "effect/unstable/cluster"
import { BranchToolWork, CurrentBranchToolFeature } from "./branch-tool-feature.js"
import type { SqlClient } from "effect/unstable/sql"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  AgentName,
  DEFAULT_AGENT_NAME,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { AgentSwitched, type AgentEvent } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import type { Message, MessageMetadata } from "../../domain/message.js"
import type { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import type { BranchId, InteractionRequestId, MessageId, SessionId } from "../../domain/ids.js"
import {
  ExtensionHostContextProvider,
  makeExtensionHostContextProvider,
} from "../make-extension-host-context.js"
import type { ConfigService } from "../config-service.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { StorageError } from "../../domain/storage-error.js"
import type { SessionStorage } from "../../storage/session-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import type { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import type { InteractionStorage } from "../../storage/interaction-storage.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import type { SessionProfileCacheService } from "../session-profile.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { buildResourceLayer } from "../extensions/resource-host/resource-layer.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { makeExtensionHostPlatform } from "../extensions/host-platform.js"
import { ToolRunner } from "./tool-runner.js"
import type { ModelRegistry } from "../model-registry.js"
import type { GentPlatform } from "../gent-platform.js"
import { resolveTurnProfile as resolveSessionTurnProfile } from "../session-runtime-context.js"
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
  turnFailureEpoch,
} from "./agent-loop.state.js"
import type { QueueSnapshot } from "../../domain/queue.js"
import { emptyTurnMetrics, type ActiveStreamHandle } from "./turn-response.js"
import { makeAgentLoopQueue } from "./agent-loop.queue.js"
import { makeAgentLoopTurnExecution } from "./agent-loop.turn-execution.js"
import type { ProcessLocalToolReplay } from "./process-local-tool-replay.js"
import { emptyAdmissionGate, makeAgentLoopWorker } from "./agent-loop.worker.js"
import type { AgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import { makeTurnInterruption } from "./turn-interruption.js"
import type { ProcessRunner } from "../../runtime/run-process.js"

type AgentLoopRuntimeServices =
  | SessionStorage
  | SessionOperationStorage
  | MessageStorage
  | EventStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ModelRegistry
  | ToolRunner
  | EventPublisher
  | InteractionStorage

type AgentLoopRuntimeContext = Context.Context<AgentLoopRuntimeServices>

const captureAgentLoopRuntimeContext: Effect.Effect<
  AgentLoopRuntimeContext,
  never,
  AgentLoopRuntimeServices
> = Effect.context<AgentLoopRuntimeServices>()

const provideAgentLoopRuntimeContext =
  (ctx: AgentLoopRuntimeContext) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, AgentLoopRuntimeServices>> =>
    Effect.provideContext(effect, ctx)

const resolveStoredAgent = Effect.fn("AgentLoop.resolveStoredAgent")(function* (params: {
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
    .pipe(Effect.option, Effect.map(Option.flatMap(Option.fromUndefinedOr)))

  if (Option.isSome(latestAgentEvent) && latestAgentEvent.value._tag === "AgentSwitched") {
    const name = latestAgentEvent.value.toAgent
    if (Schema.is(AgentName)(name)) return name
  }
  return DEFAULT_AGENT_NAME
})

export type AgentLoopBehavior = {
  persistenceFailure: Effect.Effect<void, AgentLoopError>
  readState: Effect.Effect<AgentLoopState>
  /** The newest user message whose turn never completed; what a reopened loop resumes. */
  incompleteUserTurn: Effect.Effect<Option.Option<Message>>
  /** Whether this session has ever written to the branch; a cold loop with history wakes. */
  hasPriorHistory: Effect.Effect<boolean>
  stateChanges: Stream.Stream<AgentLoopState>
  runtimeState: Effect.Effect<SessionRuntimeState>
  queueSnapshot: Effect.Effect<QueueSnapshot>
  reserveStartOrQueueFollowUp: (
    item: QueuedTurnItem,
    options: { readonly queueOnly: boolean },
  ) => Effect.Effect<Option.Option<RunningState>, AgentLoopError>
  takeNextQueuedTurnIfIdle: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  appendSteering: (item: QueuedTurnItem) => Effect.Effect<LoopState, AgentLoopError>
  drainQueue: Effect.Effect<QueueSnapshot, AgentLoopError>
  removeFollowUp: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  resolveTurnProfile: Effect.Effect<AgentLoopTurnProfile>
  /**
   * Branch-lifetime services: the cell kernel, the model context ledger, and
   * every extension Resource declared with `scope: "branch"`. Extension leaves
   * invoked outside a turn (an `extension.request` RPC, say) must be given this
   * context, or a branch Resource resolves as "Service not found".
   */
  branchContext: Context.Context<never>
  refreshRuntimeState: Effect.Effect<void, AgentLoopError>
  /** Read the current FSM state. Replaces effect-machine `actor.snapshot`. */
  snapshot: Effect.Effect<LoopState>
  startTurn: (item: QueuedTurnItem) => Effect.Effect<void, AgentLoopError>
  interrupt: (messageId?: MessageId) => Effect.Effect<void, AgentLoopError>
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
  if (Schema.is(AgentLoopError)(error)) {
    return error
  }
  return new AgentLoopError({
    message: "Agent loop turn failed",
    cause: error,
  })
}

/**
 * Closure-local follow-up enqueue. Stand-in for the legacy
 * `service.queueFollowUp` recursive reference; routes back through the actor
 * via mutual recursion with `Message` as the authoritative payload.
 */
type EnqueueFollowUp = (input: {
  sourceId: string
  sessionId: SessionId
  branchId: BranchId
  content: string
  metadata?: MessageMetadata
  wake?: boolean
}) => Effect.Effect<void, AgentLoopError | StorageError>

/** Removes a queued follow-up by its source; false when absent or already running. */
type DequeueFollowUp = (input: {
  sessionId: SessionId
  branchId: BranchId
  sourceId: string
}) => Effect.Effect<boolean, AgentLoopError>

interface AgentLoopFollowUpService {
  readonly enqueue: EnqueueFollowUp
  readonly dequeue: DequeueFollowUp
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
  profileCache?: SessionProfileCacheService,
): Effect.Effect<
  AgentLoopBehavior,
  never,
  | Scope.Scope
  | Entity.CurrentAddress
  | SessionStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | EventStorage
  | SessionOperationStorage
  | ToolCallBindingStorage
  | InteractionStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ExtensionRegistry
  | DriverRegistry
  | EventPublisher
  | ToolRunner
  | ProcessLocalToolReplay
  | AgentLoopFollowUp
  | ConfigService
  | ModelRegistry
  | ChildProcessSpawner
  | GentPlatform
  | ProcessRunner
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    yield* ModelResolver
    const extensionRegistry = yield* ExtensionRegistry
    const driverRegistry = yield* DriverRegistry
    const eventPublisher = yield* EventPublisher
    yield* ToolCallBindingStorage
    yield* ToolRunner
    const followUp = yield* AgentLoopFollowUp
    const messageStorage = yield* MessageStorage
    const recoveryEvents = yield* EventStorage
    const host = yield* makeExtensionHostPlatform
    const runtimeContext = yield* captureAgentLoopRuntimeContext
    const entityContext = yield* Effect.context<Entity.CurrentAddress>()
    const sharding = yield* Effect.serviceOption(Sharding.Sharding)
    // The local test actor has no cluster or idle reaper. Production actors
    // hold the cluster entity while their detached turn worker is active.
    const keepAlive = (enabled: boolean) =>
      Option.match(sharding, {
        onNone: () => Effect.void,
        onSome: (service) =>
          Entity.keepAlive(enabled).pipe(
            Effect.provideService(Sharding.Sharding, service),
            Effect.provideContext(entityContext),
          ),
      })

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

    const hostProvider = yield* makeExtensionHostContextProvider({
      extensionRegistry,
      host,
      sessionControl: {
        queueFollowUp: (input): Effect.Effect<void, AgentLoopError | StorageError> =>
          followUp.enqueue(input),
        dequeueFollowUp: (input): Effect.Effect<boolean, AgentLoopError> => followUp.dequeue(input),
      },
    })

    const resolveTurnProfile = provideAgentLoopRuntimeContext(runtimeContext)(
      resolveSessionTurnProfile({
        sessionId,
        branchId,
        profileCache,
        defaults: {
          driverRegistry,
          baseSections,
        },
      }).pipe(Effect.provideService(ExtensionHostContextProvider, hostProvider)),
    )

    const loopScope = yield* Effect.scope
    const turnInterruption = yield* makeTurnInterruption
    // Branch-owned turn services: the cell kernel, the model context ledger, and
    // every extension Resource declared with `scope: "branch"`. All three share
    // `loopScope`, so they are rebuilt per loop and interrupted when the branch
    // closes. Process-scope Resources are not collected here — they belong to
    // the process graph host and outlive this scope.
    const branchResourceLayer = buildResourceLayer(
      extensionRegistry.getResolved().extensions,
      "branch",
    )
    const branchTools = yield* CurrentBranchToolFeature
    const branchContext = yield* Layer.build(
      Layer.merge(
        branchTools.branchLayer({ sessionId, branchId, turnInterruption }),
        branchResourceLayer,
      ),
    ).pipe(Scope.provide(loopScope))
    const turnWorkerQueue = yield* TxQueue.unbounded<RunningState>()
    const activeStreamRef = yield* Ref.make<Option.Option<ActiveStreamHandle>>(Option.none())
    const turnMetricsRef = yield* Ref.make(emptyTurnMetrics())
    // A tool holding branch-scoped work exposes how to cancel it. A branch
    // whose tools are all stateless has nothing to cancel.
    const branchWork = Context.getOption(branchContext, BranchToolWork)
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

    const queue = yield* makeAgentLoopQueue({
      sessionId,
      branchId,
      loopRef,
      queuePersistenceSemaphore,
      persistenceFailure,
      startedRef,
    })

    const recordTurnFailure = (cause: Cause.Cause<unknown>) =>
      TxSubscriptionRef.update(loopRef, (s) => ({
        ...s,
        turnFailure: {
          epoch: turnFailureEpoch(s) + 1,
          error: causeToAgentLoopError(cause),
        },
      }))

    const {
      readState,
      stateChanges,
      runtimeState,
      queueSnapshot,
      currentLoopState,
      refreshRuntimeState,
      reserveStartOrQueueFollowUp,
      takeNextQueuedTurnIfIdle,
      takeNextQueuedTurn: takeNextQueuedTurnCommitted,
      clearInFlightTurn,
      appendSteering,
      takeSteeringForStep,
      drainQueue,
      removeFollowUp,
      saveCheckpoint,
    } = queue

    const switchAgentOnState = (state: LoopState, next: AgentNameType): Effect.Effect<LoopState> =>
      Effect.gen(function* () {
        const previous = state.currentAgent ?? DEFAULT_AGENT_NAME
        if (previous === next) return state
        const { turnExtensionRegistry: switchRegistry } = yield* resolveTurnProfile
        const agents = [...switchRegistry.getResolved().agents.values()]
        const resolved = agents.find((agent) => agent.name === next)
        if (Predicate.isUndefined(resolved)) return state

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

    const { runTurn } = yield* makeAgentLoopTurnExecution({
      sessionId,
      branchId,
      resolveTurnProfile,
      activeStreamRef,
      turnMetricsRef,
      turnInterruption,
      clearInFlightTurn,
      takeSteeringForStep,
    })

    const worker = makeAgentLoopWorker({
      sessionId,
      branchId,
      sideMutationSemaphore,
      interruptSemaphore: yield* Semaphore.make(1),
      turnWorkerQueue,
      activeStreamRef,
      turnInterruption,
      interruptToolWork: Option.match(branchWork, {
        onNone: () => Effect.void,
        onSome: (work) => work.cancel,
      }),
      currentLoopState,
      saveCheckpoint,
      takeNextQueuedTurn: takeNextQueuedTurnCommitted,
      clearInFlightTurn,
      admissionGateRef: yield* Ref.make(emptyAdmissionGate),
      recordTurnFailure,
      publishEvent,
      runTurn: (state) =>
        Effect.acquireUseRelease(
          keepAlive(true),
          () => runTurn(state).pipe(Effect.provideContext(branchContext)),
          () => keepAlive(false),
        ),
      switchAgentOnState,
    })

    const startTurnWorker = Effect.forkIn(
      provideAgentLoopRuntimeContext(runtimeContext)(worker.turnWorkerLoop),
      loopScope,
      {
        startImmediately: true,
      },
    ).pipe(Effect.asVoid)

    const start = Effect.suspend(
      Effect.fn("AgentLoop.start")(function* () {
        if (yield* Ref.getAndSet(startedRef, true)) return
        yield* startTurnWorker
      }),
    )

    const close = Effect.suspend(
      Effect.fn("AgentLoop.close")(function* () {
        yield* worker.interruptActiveStream
        yield* Deferred.succeed(closed, void 0).pipe(Effect.ignore)
        yield* Scope.close(loopScope, Exit.void)
      }),
    ).pipe(Effect.ignore)

    const hasPriorHistory = messageStorage.listMessages(branchId).pipe(
      Effect.catchEager(() => Effect.succeed([])),
      Effect.map((messages) => messages.some((message) => message.sessionId === sessionId)),
    )

    const incompleteUserTurn = Effect.gen(function* () {
      const envelopes = yield* recoveryEvents
        .listEvents({ sessionId, branchId })
        .pipe(Effect.catchEager(() => Effect.succeed([])))
      const completed = new Set(
        envelopes.flatMap(({ event }) => {
          if (event._tag === "TurnCompleted" && Predicate.isNotUndefined(event.messageId)) {
            return [event.messageId]
          }
          return []
        }),
      )
      // Continuation prompts belong to the turn that persisted them; they
      // never complete on their own and must not start a turn of their own.
      const incomplete = envelopes.flatMap(({ event }) => {
        if (
          event._tag === "MessageReceived" &&
          event.message.role === "user" &&
          event.message.metadata?.customType !== "continuation" &&
          !completed.has(event.message.id)
        ) {
          return [event.message]
        }
        return []
      })
      return Option.fromUndefinedOr(incomplete.at(-1))
    })

    return {
      persistenceFailure: Deferred.await(persistenceFailure),
      readState,
      incompleteUserTurn,
      hasPriorHistory,
      stateChanges,
      runtimeState,
      queueSnapshot,
      reserveStartOrQueueFollowUp,
      takeNextQueuedTurnIfIdle,
      appendSteering,
      drainQueue,
      removeFollowUp: (messageId) =>
        removeFollowUp(messageId).pipe(
          Effect.flatMap((removed) => {
            if (removed) return Effect.succeed(true)
            return worker.withdrawAdmittedTurn(messageId)
          }),
        ),
      resolveTurnProfile,
      branchContext,
      refreshRuntimeState,
      snapshot: currentLoopState,
      startTurn: worker.startTurn,
      interrupt: worker.interrupt,
      switchAgent: worker.switchAgent,
      respondInteraction: worker.respondInteraction,
      withSideMutation: worker.withSideMutation,
      start,
      awaitExit: Deferred.await(closed),
      close,
    } satisfies AgentLoopBehavior
  })
