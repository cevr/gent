import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Semaphore,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import {
  AgentRunError,
  DEFAULT_AGENT_NAME,
  type RunSpec,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { emptyQueueSnapshot, type QueueSnapshot } from "../../domain/queue.js"
import { AgentLoopRecoveryAbandoned, type RecoveryAbandonReason } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { Message, TextPart, type MessageMetadata } from "../../domain/message.js"
import {
  ActorCommandId,
  type InteractionRequestId,
  MessageId,
  type ToolCallId,
  type BranchId,
  type SessionId,
} from "../../domain/ids.js"
import { ConfigService } from "../config-service.js"
import { GentPlatform } from "../gent-platform.js"
import { ModelRegistry } from "../model-registry.js"
import { DEFAULTS } from "../../domain/defaults.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { StorageError } from "../../domain/storage-error.js"
import { SessionStorage } from "../../storage/session-storage.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { StorageTransaction } from "../../storage/storage-transaction.js"
import { CheckpointStorage } from "../../storage/checkpoint-storage.js"
import { AgentLoopStateRegistry } from "./agent-loop.state-registry.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { Provider } from "../../providers/provider.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { ToolRunner } from "./tool-runner"
import { ResourceManager } from "../resource-manager.js"
import {
  appendFollowUpQueueState,
  appendSteeringItem,
  buildRunningState,
  countQueuedFollowUps,
  emptyLoopQueueState,
  SessionRuntimeStateSchema,
  projectRuntimeState,
  type LoopQueueState,
  type SessionRuntimeState,
  type QueuedTurnItem,
} from "./agent-loop.state.js"
import {
  AgentLoopError,
  SteerCommand,
  assistantMessageIdForCommand,
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
export { AgentLoopError, SteerCommand }
import {
  invokeToolPhase,
  persistMessageReceived,
  recordToolResultPhase,
  type PricingLookup,
  type TurnStorage,
} from "./phases/turn.js"
import {
  LoopDriverEvent,
  type LoopHandle,
  awaitIdleStateSince,
  awaitTurnFailure,
  causeToAgentLoopError,
  failIfTurnFailedSince,
  interruptActiveStream,
  makeAgentLoopBehavior,
  type AgentLoopBehaviorDeps,
} from "./agent-loop.behavior.js"
import { AgentLoop as AgentLoopActor } from "./agent-loop.actor.js"
import { entityIdOf } from "./agent-loop.entity-id.js"

// Agent Loop Context

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
  readonly queueFollowUp: (input: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    metadata?: MessageMetadata
  }) => Effect.Effect<void, AgentLoopError | StorageError>
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
  }) => Effect.Effect<SessionRuntimeState, AgentLoopError>
  readonly watchState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<Stream.Stream<SessionRuntimeState>, AgentLoopError>
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
    | SessionStorage
    | MessageStorage
    | EventStorage
    | StorageTransaction
    | CheckpointStorage
    | Provider
    | ExtensionRegistry
    | DriverRegistry
    | EventPublisher
    | ToolRunner
    | ResourceManager
    | ConfigService
    | ModelRegistry
    | GentPlatform
    | AgentLoopStateRegistry
    | AgentLoopSessionGovernance
    | Context.Service.Identifier<typeof AgentLoopActor.Context>
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const actorClientFactory = yield* AgentLoopActor.Context
        const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
          actorClientFactory(entityIdOf(sessionId, branchId))
        const sessionStorage = yield* SessionStorage
        const messageStorage = yield* MessageStorage
        const eventStorage = yield* EventStorage
        const storageTransaction = yield* StorageTransaction
        const turnStorage: TurnStorage = {
          transaction: storageTransaction,
          events: eventStorage,
          messages: messageStorage,
          sessions: sessionStorage,
        }
        const checkpointStorage = yield* CheckpointStorage
        const provider = yield* Provider
        const extensionRegistry = yield* ExtensionRegistry
        const driverRegistry = yield* DriverRegistry
        const eventPublisher = yield* EventPublisher
        const toolRunner = yield* ToolRunner
        const resourceManager = yield* ResourceManager
        const platform = yield* GentPlatform
        const nextActorCommandId = Effect.map(platform.randomId, (id) => ActorCommandId.make(id))
        const stateRegistry = yield* AgentLoopStateRegistry
        const sessionGovernance = yield* AgentLoopSessionGovernance
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
            Effect.catchEager(() =>
              Effect.sync(
                (): { readonly input: number; readonly output: number } | undefined => undefined,
              ),
            ),
          )
        // Nested SessionId → BranchId → value maps. Counsel C5.4.4.a finding:
        // delimiter-encoded composite keys are structurally unsound since
        // SessionId/BranchId are unconstrained branded strings.
        type LoopsByBranch = ReadonlyMap<BranchId, LoopHandle>
        type LoopsBySession = ReadonlyMap<SessionId, LoopsByBranch>
        type SemaphoresByBranch = ReadonlyMap<BranchId, Semaphore.Semaphore>
        type SemaphoresBySession = ReadonlyMap<SessionId, SemaphoresByBranch>

        const loopsRef = yield* Ref.make<LoopsBySession>(new Map())
        const mutationSemaphoresRef = yield* Ref.make<SemaphoresBySession>(new Map())
        const loopsSemaphore = yield* Semaphore.make(1)
        const loopWatcherScope = yield* Scope.make()
        let service: AgentLoopService

        const findLoopHandle = (
          loops: LoopsBySession,
          sessionId: SessionId,
          branchId: BranchId,
        ): LoopHandle | undefined => loops.get(sessionId)?.get(branchId)

        const setLoopHandle = (
          loops: LoopsBySession,
          sessionId: SessionId,
          branchId: BranchId,
          handle: LoopHandle,
        ): LoopsBySession => {
          const next = new Map(loops)
          const branches = new Map(next.get(sessionId) ?? new Map())
          branches.set(branchId, handle)
          next.set(sessionId, branches)
          return next
        }

        const deleteLoopHandle = (
          loops: LoopsBySession,
          sessionId: SessionId,
          branchId: BranchId,
        ): LoopsBySession => {
          const branches = loops.get(sessionId)
          if (branches === undefined) return loops
          if (!branches.has(branchId)) return loops
          const next = new Map(loops)
          const nextBranches = new Map(branches)
          nextBranches.delete(branchId)
          if (nextBranches.size === 0) next.delete(sessionId)
          else next.set(sessionId, nextBranches)
          return next
        }

        const getMutationSemaphore = Effect.fn("AgentLoop.getMutationSemaphore")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const existing = (yield* Ref.get(mutationSemaphoresRef)).get(sessionId)?.get(branchId)
          if (existing !== undefined) return existing

          const semaphore = yield* Semaphore.make(1)
          return yield* loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(mutationSemaphoresRef)).get(sessionId)?.get(branchId)
              if (current !== undefined) return current
              yield* Ref.update(mutationSemaphoresRef, (semaphores) => {
                const next = new Map(semaphores)
                const branches = new Map(next.get(sessionId) ?? new Map())
                branches.set(branchId, semaphore)
                next.set(sessionId, branches)
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
              yield* Ref.update(loopsRef, (loops) => {
                if (findLoopHandle(loops, sessionId, branchId) !== handle) return loops
                return deleteLoopHandle(loops, sessionId, branchId)
              })
              yield* stateRegistry.deregister(sessionId, branchId, handle.loopRef)
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

        const behaviorDeps: AgentLoopBehaviorDeps = {
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
          baseSections: config.baseSections,
          // Closure-local follow-up enqueue. Routes back through the
          // service-level `queueFollowUp`, which handles dedup/limit checks.
          // c.1.b will replace this with a direct closure-local call once the
          // behavior owns its own queue policy.
          enqueueFollowUp: (input) => service.queueFollowUp(input),
        }

        const makeLoop = (
          sessionId: SessionId,
          branchId: BranchId,
          sideMutationSemaphore: Semaphore.Semaphore,
          initialQueue: LoopQueueState = emptyLoopQueueState(),
        ) =>
          makeAgentLoopBehavior(
            behaviorDeps,
            sessionId,
            branchId,
            sideMutationSemaphore,
            initialQueue,
          )

        const getLoop = Effect.fn("AgentLoop.getLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const sideMutationSemaphore = yield* getMutationSemaphore(sessionId, branchId)
          // Allocate + register under semaphore, then run `start` outside.
          // The plain-Effect driver does not auto-fork its turn fiber until
          // `start` is invoked, so the handle must be installed in loopsRef
          // before recovery runs — otherwise a recovered Running turn would
          // re-enter getLoop and deadlock waiting on the same semaphore.
          const created = yield* Effect.withSpan("AgentLoop.getLoop.semaphore")(
            loopsSemaphore.withPermits(1)(
              Effect.gen(function* () {
                if (yield* sessionGovernance.isTerminated(sessionId)) {
                  return yield* new AgentLoopError({
                    message: `Session runtime terminated: ${sessionId}`,
                  })
                }
                const existing = findLoopHandle(yield* Ref.get(loopsRef), sessionId, branchId)
                if (existing !== undefined) return undefined
                const handle = yield* makeLoop(sessionId, branchId, sideMutationSemaphore)
                yield* Ref.update(loopsRef, (loops) =>
                  setLoopHandle(loops, sessionId, branchId, handle),
                )
                yield* stateRegistry.register(sessionId, branchId, {
                  loopRef: handle.loopRef,
                  queueMutationSemaphore: handle.queueMutationSemaphore,
                  persistQueueState: handle.persistQueueState,
                  closed: handle.closed,
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
          const existing = findLoopHandle(yield* Ref.get(loopsRef), sessionId, branchId)
          if (existing === undefined) {
            return yield* Effect.die(
              new Error(`Loop handle missing for ${sessionId}/${branchId} after creation`),
            )
          }
          return existing
        })

        const findLoop = Effect.fn("AgentLoop.findLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          return findLoopHandle(yield* Ref.get(loopsRef), sessionId, branchId)
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
          if (yield* sessionGovernance.isTerminated(sessionId)) return undefined
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

        const _terminateSession = Effect.fn("AgentLoop.terminateSession")(function* (
          sessionId: SessionId,
        ) {
          const loopsToClose = yield* loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              yield* sessionGovernance.markTerminated(sessionId)

              const branches = (yield* Ref.get(loopsRef)).get(sessionId)
              const selected = branches === undefined ? [] : Array.from(branches.values())

              yield* Ref.update(loopsRef, (loops) => {
                if (!loops.has(sessionId)) return loops
                const next = new Map(loops)
                next.delete(sessionId)
                return next
              })
              yield* Ref.update(mutationSemaphoresRef, (semaphores) => {
                if (!semaphores.has(sessionId)) return semaphores
                const next = new Map(semaphores)
                next.delete(sessionId)
                return next
              })
              // Deregister the registry entries in the same critical section
              // so no read-side caller can observe a stale handle between the
              // loopsRef delete and `closeLoopHandle` finalization.
              yield* stateRegistry.deregisterSession(sessionId)
              return selected
            }),
          )

          yield* Effect.forEach(loopsToClose, closeLoopHandle, {
            concurrency: "unbounded",
            discard: true,
          })
        })

        const _restoreSession = Effect.fn("AgentLoop.restoreSession")(function* (
          sessionId: SessionId,
        ) {
          yield* loopsSemaphore.withPermits(1)(sessionGovernance.clearTerminated(sessionId))
        })

        const submitTurn = Effect.fn("AgentLoop.submitTurn")(function* (
          command: SubmitTurnCommand,
        ) {
          const loop = yield* getLoop(command.message.sessionId, command.message.branchId)
          const item = buildQueuedTurnItem(command)
          const reservedStart = yield* loop.queueMutationSemaphore.withPermits(1)(
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

              const startedAtMs = yield* Clock.currentTimeMillis
              const reservedRunningState = buildRunningState(loopState, item, { startedAtMs })
              yield* SubscriptionRef.update(loop.loopRef, (s) => ({
                ...s,
                startingState: reservedRunningState,
              }))
              return reservedRunningState
            }),
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
                id: MessageId.make(yield* platform.randomId),
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
                const recordCommandId =
                  command.commandId ?? ActorCommandId.make(yield* platform.randomId)
                yield* recordToolResultPhase({
                  storage: turnStorage,
                  eventPublisher,
                  commandId: recordCommandId,
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
                const commandId = command.commandId ?? ActorCommandId.make(yield* platform.randomId)
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
                  storage: turnStorage,
                })
              }),
            )
            .pipe(Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))))
        })

        const _dispatchLoopCommand = Effect.fn("AgentLoop.dispatchLoopCommand")(function* (
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

        const _enqueueFollowUp = Effect.fn("AgentLoop.enqueueFollowUp")(function* (
          message: Message,
        ) {
          const existingLoop = yield* findLoop(message.sessionId, message.branchId)
          const loop = existingLoop ?? (yield* getLoop(message.sessionId, message.branchId))
          const item = { message }
          const reservedStart = yield* loop.queueMutationSemaphore.withPermits(1)(
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
              const startedAtMs = yield* Clock.currentTimeMillis
              const reservedRunningState = buildRunningState(loopState, item, { startedAtMs })
              yield* SubscriptionRef.update(loop.loopRef, (s) => ({
                ...s,
                startingState: reservedRunningState,
              }))
              return reservedRunningState
            }),
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

        service = {
          runOnce: Effect.fn("AgentLoop.runOnce")(function* (input) {
            const userMessage = Message.Regular.make({
              id: MessageId.make(yield* platform.randomId),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.prompt })],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* persistMessageReceived({
              storage: turnStorage,
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
            const ref = yield* agentLoopActorRefFor(message.sessionId, message.branchId)
            return yield* ref.execute(
              AgentLoopActor.Submit.make({
                message,
                agentOverride: options?.agentOverride,
                runSpec: options?.runSpec,
                interactive: options?.interactive,
              }),
            )
          }),

          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              runSpec?: RunSpec
              interactive?: boolean
            },
          ) {
            const ref = yield* agentLoopActorRefFor(message.sessionId, message.branchId)
            return yield* ref.execute(
              AgentLoopActor.Run.make({
                message,
                agentOverride: options?.agentOverride,
                runSpec: options?.runSpec,
                interactive: options?.interactive,
              }),
            )
          }),

          queueFollowUp: Effect.fn("AgentLoop.queueFollowUp")(function* (input) {
            const message = Message.Regular.make({
              id: MessageId.make(yield* platform.randomId),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.content })],
              createdAt: yield* DateTime.nowAsDate,
              ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            })
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.QueueFollowUp.make({
                message,
                agentOverride: undefined,
                runSpec: undefined,
                interactive: undefined,
              }),
            )
          }),

          steer: Effect.fn("AgentLoop.steer")(function* (command) {
            const ref = yield* agentLoopActorRefFor(command.sessionId, command.branchId)
            yield* ref.execute(
              AgentLoopActor.Steer.make({
                commandId: yield* nextActorCommandId,
                command,
              }),
            )
          }),

          drainQueue: Effect.fn("AgentLoop.drainQueue")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.DrainQueue.make({
                ...input,
                commandId: yield* nextActorCommandId,
              }),
            )
          }),

          getQueue: Effect.fn("AgentLoop.getQueue")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(AgentLoopActor.GetQueue.make(input))
          }),

          respondInteraction: Effect.fn("AgentLoop.respondInteraction")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(AgentLoopActor.RespondInteraction.make(input))
          }),

          recordToolResult: Effect.fn("AgentLoop.recordToolResult")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.RecordToolResult.make({
                ...input,
                commandId: input.commandId,
                isError: input.isError,
              }),
            )
          }),

          invokeTool: Effect.fn("AgentLoop.invokeTool")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.InvokeTool.make({
                ...input,
                commandId: input.commandId ?? (yield* nextActorCommandId),
              }),
            )
          }),

          getState: Effect.fn("AgentLoop.getState")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(AgentLoopActor.GetState.make(input))
          }),
          watchState: Effect.fn("AgentLoop.watchState")(function* (input) {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(AgentLoopActor.EnsureStarted.make(input))
            const registered = yield* stateRegistry.find(input.sessionId, input.branchId)
            if (registered === undefined) {
              return yield* new AgentLoopError({
                message: `AgentLoop state unavailable: ${input.sessionId}/${input.branchId}`,
              })
            }
            const changes = SubscriptionRef.changes(registered.loopRef).pipe(
              Stream.map(projectRuntimeState),
            )
            return registered.closed === undefined
              ? changes
              : changes.pipe(Stream.interruptWhen(Deferred.await(registered.closed)))
          }),

          terminateSession: Effect.fn("AgentLoop.terminateSession")(function* (sessionId) {
            yield* sessionGovernance.markTerminated(sessionId)
            const branchIds = yield* stateRegistry.listForSession(sessionId)
            yield* Effect.forEach(
              branchIds,
              (branchId) =>
                agentLoopActorRefFor(sessionId, branchId).pipe(
                  Effect.flatMap((ref) =>
                    ref.execute(
                      AgentLoopActor.TerminateBranch.make({
                        sessionId,
                        branchId,
                      }),
                    ),
                  ),
                  Effect.ignore,
                ),
              { concurrency: "unbounded", discard: true },
            )
            yield* stateRegistry.deregisterSession(sessionId)
          }),
          restoreSession: (sessionId) => sessionGovernance.clearTerminated(sessionId),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const loops = yield* Ref.get(loopsRef)
            const allHandles: ReadonlyArray<LoopHandle> = Array.from(loops.values()).flatMap(
              (branches) => Array.from(branches.values()),
            )
            yield* Effect.forEach(allHandles, closeLoopHandle, {
              concurrency: "unbounded",
            })
            yield* Scope.close(loopWatcherScope, Exit.void)
          }),
        )

        return service
      }),
    )

  static Test = (overrides: Partial<AgentLoopService> = {}): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      runOnce: () => Effect.void,
      submit: () => Effect.void,
      run: () => Effect.void,
      queueFollowUp: () => Effect.void,
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
          SessionRuntimeStateSchema.Idle.make({
            agent: DEFAULT_AGENT_NAME,
            queue: emptyQueueSnapshot(),
          }),
        ),
      watchState: () => Effect.succeed(Stream.empty),
      ...overrides,
    })
}
