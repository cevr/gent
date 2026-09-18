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
  type FileSystem,
  type Path,
} from "effect"
import { Entity, Sharding } from "effect/unstable/cluster"
import {
  BranchToolWork,
  CurrentBranchToolFeature,
  makeTurnInterruption,
  type ProcessLocalToolReplay,
  ToolRunner,
} from "../tools.js"
import type { SqlClient } from "effect/unstable/sql"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { type AgentEvent, EventPublisher } from "../../domain/event.js"
import {
  emptyLoopQueueState,
  isRuntimeUserMessage,
  type LoopQueueState,
  type Message,
  type MessageMetadata,
  type QueuedTurnItem,
} from "../../domain/message.js"
import {
  type AgentLoopQueueStorage,
  EventStorage,
  type InteractionStorage,
  MessageStorage,
  type SessionOperationStorage,
  type SessionStorage,
  ToolCallBindingStorage,
  TurnRecordStorage,
} from "../../storage/storage.js"
import type { BranchId, InteractionRequestId, MessageId, SessionId } from "../../domain/ids.js"
import {
  buildResourceLayer,
  DriverRegistry,
  ExtensionHostContextProvider,
  ExtensionRegistry,
  makeExtensionHostContextProvider,
  makeExtensionHostPlatform,
  resolveTurnProfile as resolveSessionTurnProfile,
  type SessionProfileCacheService,
} from "../extension-host.js"
import type { ConfigService } from "../config.js"
import type { PromptSection } from "../../domain/capability.js"
import type { StorageError } from "../../domain/errors.js"
import { type ModelRegistry, ModelResolver } from "../provider.js"
import type { GentPlatform } from "../gent-platform.js"
import {
  buildIdleState,
  AgentLoopError,
  asAgentLoopError,
  type RunningState,
} from "../../domain/agent-loop.js"
import {
  buildInitialAgentLoopState,
  makeLoopInbox,
  turnFailureEpoch,
  type AgentLoopState,
  type LoopInbox,
} from "./loop-inbox.js"
import {
  type ActiveStreamHandle,
  type AgentLoopTurnProfile,
  makeAgentLoopTurnExecution,
  makeTurnLedger,
} from "../turn.js"
import { emptyAdmissionGate, makeAgentLoopWorker } from "./agent-loop.worker.js"

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

export type AgentLoopBehavior = {
  persistenceFailure: Effect.Effect<void, AgentLoopError>
  /**
   * Everything this branch has accepted and not yet answered. The behavior
   * does not restate the inbox's verbs: a caller that wants to admit, steer,
   * withdraw or read the queue asks the inbox itself.
   */
  inbox: LoopInbox
  /** The newest user message whose turn never completed; what a reopened loop resumes. */
  incompleteUserTurn: Effect.Effect<Option.Option<Message>>
  /** Whether this session has ever written to the branch; a cold loop with history wakes. */
  hasPriorHistory: Effect.Effect<boolean>
  /**
   * Withdraw a follow-up the loop may already have admitted. The inbox alone
   * cannot answer this: an item the worker has claimed has left the queue, so
   * the withdrawal has to reach the admission gate as well.
   */
  withdrawFollowUp: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  resolveTurnProfile: Effect.Effect<AgentLoopTurnProfile>
  /**
   * Branch-lifetime services: the cell kernel, the model context ledger, and
   * every extension Resource declared with `scope: "branch"`. Extension leaves
   * invoked outside a turn (an `extension.request` RPC, say) must be given this
   * context, or a branch Resource resolves as "Service not found".
   */
  branchContext: Context.Context<never>
  startTurn: (item: QueuedTurnItem) => Effect.Effect<void, AgentLoopError>
  interrupt: (messageId?: MessageId) => Effect.Effect<void, AgentLoopError>
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
 * Closure-local follow-up enqueue. Routes back through the actor via mutual
 * recursion, with `Message` as the authoritative payload.
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
  | TurnRecordStorage
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
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    yield* ModelResolver
    const extensionRegistry = yield* ExtensionRegistry
    const driverRegistry = yield* DriverRegistry
    const eventPublisher = yield* EventPublisher
    yield* ToolCallBindingStorage
    yield* TurnRecordStorage
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
      eventPublisher.publish(event).pipe(asAgentLoopError(`Failed to publish ${event._tag}`))

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
    const turnLedger = yield* makeTurnLedger
    // A tool holding branch-scoped work exposes how to cancel it. A branch
    // whose tools are all stateless has nothing to cancel.
    const branchWork = Context.getOption(branchContext, BranchToolWork)
    const initialLoopState = buildIdleState()
    const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
      buildInitialAgentLoopState({ state: initialLoopState, queue: initialQueue }),
    )
    const queuePersistenceSemaphore = yield* Semaphore.make(1)
    const persistenceFailure = yield* Deferred.make<void, AgentLoopError>()
    const closed = yield* Deferred.make<void>()
    const startedRef = yield* Ref.make(false)

    const inbox = yield* makeLoopInbox({
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

    const { runTurn } = yield* makeAgentLoopTurnExecution({
      sessionId,
      branchId,
      resolveTurnProfile,
      activeStreamRef,
      turnLedger,
      turnInterruption,
      inbox,
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
      inbox,
      admissionGateRef: yield* Ref.make(emptyAdmissionGate),
      recordTurnFailure,
      publishEvent,
      runTurn: (state) =>
        Effect.acquireUseRelease(
          keepAlive(true),
          () => runTurn(state).pipe(Effect.provideContext(branchContext)),
          () => keepAlive(false),
        ),
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
      // Continuation prompts, handoff markers, and model-change notices are
      // the runtime's own user-role lines; none completes on its own and none
      // must start a turn of its own.
      const incomplete = envelopes.flatMap(({ event }) => {
        if (
          event._tag === "MessageReceived" &&
          event.message.role === "user" &&
          !isRuntimeUserMessage(event.message) &&
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
      inbox,
      incompleteUserTurn,
      hasPriorHistory,
      withdrawFollowUp: (messageId) =>
        inbox.withdraw(messageId).pipe(
          Effect.flatMap((removed) => {
            if (removed) return Effect.succeed(true)
            return worker.withdrawAdmittedTurn(messageId)
          }),
        ),
      resolveTurnProfile,
      branchContext,
      startTurn: worker.startTurn,
      interrupt: worker.interrupt,
      respondInteraction: worker.respondInteraction,
      withSideMutation: worker.withSideMutation,
      start,
      awaitExit: Deferred.await(closed),
      close,
    } satisfies AgentLoopBehavior
  })
