/**
 * `AgentLoop` as `Actor.fromEntity`.
 *
 * Replaces the per-(sessionId, branchId) hand-rolled fiber map +
 * `LoopState` tagged union + actor mailbox persistence.
 *
 * **Op surface (C5.1-followup counsel):** request/reply only.
 * `Subscribe` and `Snapshot` are NOT actor ops:
 * - `Actor.fromEntity` is request/reply; `OperationHandle.watch` is
 *   polling status, not a live state stream.
 * - State subscription stays behavior-owned and is exposed through
 *   `Actor.registerState` (or `Actor.withProtocol` later if encore grows
 *   streaming-RPC support).
 *
 * **Entity ID** keys per `(sessionId, branchId)` so all ops for one branch
 * share an actor instance. Handler concurrency is intentionally unbounded;
 * behavior-owned queue and actor-owned semaphore serialize turn execution, durable queue,
 * and side-effect lanes.
 *
 * **Single source of truth for routing** (C5.2 counsel): for ops that
 * carry a domain payload owning its own `(sessionId, branchId)`,
 * top-level routing fields are dropped — the embedded payload IS the
 * authority. Only `Interrupt` (no embedded payload) carries explicit
 * target fields.
 *
 * **Execution id key** per op:
 * - `Submit` — `message.id` (live-only)
 * - `SubmitDurable` — `message.id` (persisted; actor owns request idempotency)
 * - `Run` / `QueueFollowUp` — `message.id` (live-only)
 * - `Steer` — `commandId` (persisted; actor owns request idempotency)
 * - `Interrupt` / `RespondInteraction` — durable persisted command key
 *
 * Schemas reuse gent's existing domain (`Message`, `RunSpec`,
 * `SteerCommand`) rather than introducing a parallel envelope shape.
 *
 * @module
 */

import { DateTime, Effect, Exit, Ref, Schema, Stream, Semaphore } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Actor } from "effect-encore"
import { type AgentName, type RunSpec } from "../../domain/agent.js"
import { Message, type MessageMetadata } from "../../domain/message.js"
import { MessageId, type ActorCommandId, type BranchId, type SessionId } from "../../domain/ids.js"
import { SteerCommand } from "../../domain/steer.js"
import { GentPlatform } from "../gent-platform.js"
import { CurrentWorkspaceId } from "../../server/workspace-rpc.js"
import type { PromptSection } from "../../domain/prompt.js"
import {
  assistantMessageIdForCommand,
  interjectionMessageIdForCommand,
  toolCallIdForCommand,
  toolResultMessageIdForCommand,
  toolResultMessageIdForToolCall,
} from "./agent-loop.utils.js"
import {
  AgentLoopError,
  emptyLoopQueueState,
  projectRuntimeState,
  type QueuedTurnItem,
} from "./agent-loop.state.js"
import {
  AgentLoopFollowUp,
  type AgentLoopBehavior,
  causeToAgentLoopError,
  makeAgentLoopBehavior,
} from "./agent-loop.behavior.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { AgentLoopQueueStorage } from "../../storage/agent-loop-queue-storage.js"
import { EventStorage } from "../../storage/event-storage.js"
import { parseEntityId } from "./agent-loop.entity-id.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { recordToolResult } from "./turn-persistence.js"
import { invokeTool } from "./turn-tool-execution.js"
import { provideAgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import {
  buildQueuedTurnItem,
  failIfTurnFailedAfterEpoch,
  waitForIdleAfterEpoch,
  waitForTurnFailureAfterEpoch,
} from "./agent-loop.actor-state.js"
import {
  AgentLoop,
  type DrainQueueInput,
  type GetQueueInput,
  type GetStateInput,
  type HandlerRequest,
  type InterruptInput,
  type InvokeToolInput,
  type MessageType,
  type RecordToolResultInput,
  type RespondInteractionInput,
  type SteerCommandType,
  type SteerInput,
  type TerminateBranchInput,
  type TurnSubmissionInput,
} from "./agent-loop.protocol.js"

/**
 * `Actor.toLayer` handler layer for `AgentLoop`.
 *
 * Per-(sessionId, branchId) loop ownership lives in the actor entity instance.
 * Encore exposes `CurrentAddress` while keeping that entity-provided service
 * out of the resulting layer requirements.
 */
export const buildAgentLoopActorHandlers = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Effect.gen(function* () {
    const sideMutationSemaphore = yield* Semaphore.make(1)
    // Serializes per-entity `handle` rebuild. The actor mailbox is
    // `concurrency: "unbounded"`, so concurrent ops can both observe a
    // closed loop and race into `openLoop`, leaking the first behavior's
    // fibers and producing torn reads of `handle`/`startupExit`.
    const startupSemaphore = yield* Semaphore.make(1)
    const sessionGovernance = yield* AgentLoopSessionGovernance
    const platform = yield* GentPlatform
    const addr = yield* Actor.CurrentAddress
    const { workspaceId, sessionId, branchId } = yield* parseEntityId(addr.entityId).pipe(
      Effect.orDie,
    )
    // Storage Tags yield CurrentWorkspaceId internally — every reachable
    // call path is piped through `provideActorWorkspace` below, so storage
    // operations see the correct workspace from fiber context without any
    // per-method wrapping layer.
    const brandedWorkspaceId = workspaceId
    const provideActorWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(CurrentWorkspaceId, brandedWorkspaceId))
    const messageStorage = yield* MessageStorage
    const queueStorage = yield* AgentLoopQueueStorage
    const eventStorage = yield* EventStorage
    const closed = yield* Ref.make(false)
    const operationSeen = yield* Ref.make(false)

    // `handle` and `startupExit` were plain `let` bindings before C13.1. The
    // mailbox runs at `concurrency: "unbounded"`, so the post-flip window in
    // `openLoop` between `Ref.set(closed, false)` and the assignment of
    // `handle`/`startupExit` was racing: a fiber arriving via `ensureStarted`
    // could observe `closed=false`, skip the rebuild branch, and then read
    // a stale (now-closed) handle. Promoted to `Ref` and all reads happen
    // inside `ensureStarted` (which holds `startupSemaphore` across the
    // rebuild, the post-check, and the published handle return).
    const handleRef = yield* Ref.make<AgentLoopBehavior | undefined>(undefined)
    const startupExitRef = yield* Ref.make<Exit.Exit<void, AgentLoopError> | undefined>(undefined)

    const closeBehaviorWithHeldStartupPermit = (loop: AgentLoopBehavior) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return
        yield* Ref.set(closed, true)
        yield* loop.close
      }).pipe(Effect.ignore)

    // Holds `startupSemaphore` across the closed-flip + close so a
    // concurrent `openLoop` cannot observe a half-torn-down loop nor
    // publish a fresh handle while the old one is closing.
    const closeBehavior = (loop: AgentLoopBehavior) =>
      closeBehaviorWithHeldStartupPermit(loop).pipe(startupSemaphore.withPermits(1))

    const cleanupLoop = (loop: AgentLoopBehavior) => closeBehavior(loop)

    const currentRuntimeState = (loop: AgentLoopBehavior) => loop.runtimeState

    // Typed reentrant-only handle lookup. The only legitimate caller is the
    // `AgentLoopFollowUp` enqueue implementation provided to the behavior — it
    // fires from inside the behavior itself (during turn execution), so the
    // handle is provably published into `handleRef` by then. Mailbox handlers
    // (which arrive from outside the behavior) MUST go through `ensureStarted`
    // instead — that path holds `startupSemaphore` across the rebuild/publish,
    // ensuring no one observes a half-reopened loop.
    const reentrantHandle = Effect.gen(function* () {
      const value = yield* Ref.get(handleRef)
      if (value === undefined) {
        return yield* new AgentLoopError({
          message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
        })
      }
      return value
    })

    const hasPriorMessageHistory = Effect.gen(function* () {
      const messages = yield* messageStorage
        .listMessages(branchId)
        .pipe(Effect.catchEager(() => Effect.succeed([])))
      return messages.some((message) => message.sessionId === sessionId)
    })

    const latestIncompleteUserTurn = Effect.gen(function* () {
      const envelopes = yield* eventStorage
        .listEvents({ sessionId, branchId })
        .pipe(Effect.catchEager(() => Effect.succeed([])))
      const completed = new Set(
        envelopes.flatMap((envelope) =>
          envelope.event._tag === "TurnCompleted" && envelope.event.messageId !== undefined
            ? [envelope.event.messageId]
            : [],
        ),
      )
      const incomplete = envelopes.filter(
        (envelope) =>
          envelope.event._tag === "MessageReceived" &&
          envelope.event.message.role === "user" &&
          !completed.has(envelope.event.message.id),
      )
      const latest = incomplete[incomplete.length - 1]?.event
      return latest?._tag === "MessageReceived" ? latest.message : undefined
    })

    const hasIncompleteUserTurn = latestIncompleteUserTurn.pipe(
      Effect.map((message) => message !== undefined),
    )

    const startNextQueuedTurnIfIdle = (
      handle: AgentLoopBehavior,
      options?: { readonly startupPermitHeld?: boolean },
    ) =>
      Effect.gen(function* () {
        const start = yield* handle.takeNextQueuedTurnIfIdle
        if (start !== undefined) {
          yield* handle
            .startTurn(start)
            .pipe(
              Effect.catchEager((error) =>
                (options?.startupPermitHeld === true
                  ? closeBehaviorWithHeldStartupPermit(handle)
                  : cleanupLoop(handle)
                ).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )
        }
      })

    const markWrite = Effect.gen(function* () {
      if (yield* sessionGovernance.isTerminated(workspaceId, sessionId)) {
        return yield* new AgentLoopError({
          message: `Session runtime terminated: ${sessionId}`,
        })
      }
      return yield* Ref.modify(operationSeen, (seen) => [seen, true] as const)
    })

    const rejectIfTerminated = Effect.gen(function* () {
      if (yield* sessionGovernance.isTerminated(workspaceId, sessionId)) {
        return yield* new AgentLoopError({
          message: `Session terminated: ${sessionId}`,
        })
      }
    })

    const ensureTarget = (target: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
      target.sessionId === sessionId && target.branchId === branchId
        ? Effect.void
        : Effect.fail(
            new AgentLoopError({
              message: `AgentLoop op target mismatch: entity=${sessionId}/${branchId} payload=${target.sessionId}/${target.branchId}`,
            }),
          )

    // Both call sites supply an already-resolved `handle`:
    //   - the `AgentLoopFollowUp` enqueue implementation reads
    //     `reentrantHandle` lazily — it fires during turn execution (well
    //     after `openLoop` published `handleRef`), so the read is provably safe.
    //   - the `QueueFollowUp` mailbox handler resolves it via `ensureStarted`.
    // Taking it as a parameter eliminates the implicit two-step contract
    // that previously bypassed `ensureStarted` for non-reentrant callers.
    const enqueueMessage = Effect.fn("AgentLoopActor.enqueueMessage")(function* (
      handle: AgentLoopBehavior,
      input: {
        readonly message?: MessageType
        readonly content?: string
        readonly metadata?: MessageMetadata
        readonly agentOverride?: AgentName
        readonly runSpec?: RunSpec
        readonly interactive?: boolean
      },
    ) {
      const wasAlreadyWarm = yield* markWrite
      const message =
        input.message ??
        Message.cases.regular.make({
          id: MessageId.make(yield* platform.randomId),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: input.content ?? "" })],
          createdAt: yield* DateTime.nowAsDate,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        })

      yield* ensureTarget(message)
      const item = buildQueuedTurnItem({
        message,
        agentOverride: input.agentOverride,
        runSpec: input.runSpec,
        interactive: input.interactive,
      })
      const reservedStart = yield* handle.reserveStartOrQueueFollowUp(item, {
        coldQueueOnly: !wasAlreadyWarm,
      })
      if (reservedStart !== undefined) {
        yield* handle
          .startTurn(item)
          .pipe(
            Effect.catchEager((error) =>
              cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )
      }
      if (!wasAlreadyWarm) {
        if ((yield* hasIncompleteUserTurn) || (yield* hasPriorMessageHistory)) {
          yield* startNextQueuedTurnIfIdle(handle)
        }
        return
      }
    })

    const openLoop = Effect.gen(function* () {
      const initialQueueExit = yield* Effect.exit(
        queueStorage.getQueueState(sessionId, branchId).pipe(
          Effect.mapError(
            (cause) =>
              new AgentLoopError({
                message: `Failed to load loop queue for ${sessionId}/${branchId}`,
                cause,
              }),
          ),
        ),
      )
      const initialQueue = Exit.isSuccess(initialQueueExit)
        ? initialQueueExit.value
        : emptyLoopQueueState()
      const initialQueueFailure = Exit.isFailure(initialQueueExit)
        ? new AgentLoopError({
            message: `Failed to load loop queue for ${sessionId}/${branchId}`,
            cause: initialQueueExit.cause,
          })
        : undefined
      if (initialQueueFailure !== undefined) {
        yield* Effect.logWarning("failed to load loop queue").pipe(
          Effect.annotateLogs({
            sessionId,
            branchId,
            error: initialQueueFailure.message,
          }),
        )
      }
      const handle = yield* makeAgentLoopBehavior(
        sessionId,
        branchId,
        sideMutationSemaphore,
        config.baseSections,
        initialQueue,
      ).pipe(
        Effect.provideService(AgentLoopFollowUp, {
          enqueue: (input) => reentrantHandle.pipe(Effect.flatMap((h) => enqueueMessage(h, input))),
        }),
      )
      yield* Ref.set(handleRef, handle)
      if (initialQueueFailure !== undefined) {
        yield* Ref.set(startupExitRef, Exit.fail(initialQueueFailure))
        yield* Ref.set(closed, false)
        return
      }

      const exit = yield* Effect.exit(
        handle.start.pipe(
          Effect.andThen(handle.refreshRuntimeState),
          Effect.andThen(
            Effect.gen(function* () {
              const incompleteMessage = yield* latestIncompleteUserTurn
              if (incompleteMessage !== undefined) {
                yield* handle
                  .startTurn({ message: incompleteMessage })
                  .pipe(
                    Effect.catchEager((error) =>
                      closeBehaviorWithHeldStartupPermit(handle).pipe(
                        Effect.andThen(Effect.fail(error)),
                      ),
                    ),
                  )
                return
              }
              const hasRecoveredQueue =
                initialQueue.inFlight !== undefined ||
                initialQueue.steering.length > 0 ||
                initialQueue.followUp.length > 0
              if (!hasRecoveredQueue) return
              if (yield* hasPriorMessageHistory) {
                yield* startNextQueuedTurnIfIdle(handle, { startupPermitHeld: true })
              }
            }),
          ),
        ),
      )
      yield* Ref.set(startupExitRef, exit)
      // Publish `closed=false` only after both `handleRef` and
      // `startupExitRef` are visible. `ensureStarted` reads `closed`
      // before reading the handle/exit, so flipping it last guarantees a
      // fiber that sees `closed=false` will read the freshly-published
      // pair, not a stale one from a previous open cycle.
      yield* Ref.set(closed, false)
    })

    yield* openLoop.pipe(provideActorWorkspace)
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(handleRef), (loop) =>
        loop !== undefined ? cleanupLoop(loop) : Effect.void,
      ),
    )

    // Serialize the full read/rebuild/check path so concurrent ops cannot
    // observe a partially-rebuilt loop. `openLoop` writes `handleRef` and
    // `startupExitRef` and only flips `closed=false` after both are
    // published; `ensureStarted` then reads them inside the same permit
    // window and returns the handle directly so callers cannot read a
    // post-rebuild stale handle.
    const ensureStarted = Effect.gen(function* () {
      if (yield* Ref.get(closed)) {
        yield* openLoop.pipe(provideActorWorkspace)
      }
      const exit = yield* Ref.get(startupExitRef)
      if (exit === undefined || Exit.isSuccess(exit)) {
        const handle = yield* Ref.get(handleRef)
        if (handle === undefined) {
          return yield* new AgentLoopError({
            message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
          })
        }
        return handle
      }
      return yield* causeToAgentLoopError(exit.cause)
    }).pipe(startupSemaphore.withPermits(1))

    const currentRegisteredState = Effect.gen(function* () {
      yield* rejectIfTerminated
      const handle = yield* ensureStarted
      return yield* currentRuntimeState(handle)
    })

    const registeredStateChanges = Stream.unwrap(
      Effect.gen(function* () {
        yield* rejectIfTerminated
        const handle = yield* ensureStarted
        return handle.stateChanges.pipe(
          Stream.map(projectRuntimeState),
          Stream.interruptWhen(handle.awaitExit),
        )
      }),
    )

    yield* Actor.registerState({
      get: currentRegisteredState.pipe(provideActorWorkspace),
      watch: registeredStateChanges.pipe(
        Stream.provideService(CurrentWorkspaceId, brandedWorkspaceId),
      ),
    })

    const submitTurn = Effect.fn("AgentLoopActor.submitTurn")(function* (
      operation: TurnSubmissionInput,
    ) {
      const handle = yield* ensureStarted
      yield* ensureTarget(operation.message)
      yield* markWrite
      const item = buildQueuedTurnItem(operation)
      const reservedStart = yield* handle.reserveStartOrQueueFollowUp(item, {
        coldQueueOnly: false,
      })
      if (reservedStart !== undefined) {
        yield* handle
          .startTurn(item)
          .pipe(
            Effect.catchEager((error) =>
              cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
            ),
          )
      }
    })

    const runTurn = Effect.fn("AgentLoopActor.runTurn")(function* (operation: TurnSubmissionInput) {
      const handle = yield* ensureStarted
      yield* ensureTarget(operation.message)
      yield* markWrite
      const item = buildQueuedTurnItem(operation)
      const start = yield* handle.reserveRunStartOrQueueFollowUp(item)
      if (start === undefined) return

      yield* handle
        .startTurn(item)
        .pipe(
          Effect.catchEager((error) =>
            cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
          ),
        )

      yield* Effect.raceFirst(
        Effect.raceFirst(
          waitForIdleAfterEpoch(handle, start.stateEpochBaseline),
          waitForTurnFailureAfterEpoch(handle, start.turnFailureBaseline),
        ),
        handle.persistenceFailure,
      ).pipe(
        Effect.catchEager((error) => cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error)))),
      )
      yield* failIfTurnFailedAfterEpoch(handle, start.turnFailureBaseline)
    })

    const applySteer = Effect.fn("AgentLoopActor.applySteer")(function* (
      commandId: ActorCommandId,
      command: SteerCommandType,
    ) {
      const handle = yield* ensureStarted
      yield* ensureTarget(command)
      yield* markWrite
      const projectedState = yield* currentRuntimeState(handle)

      switch (command._tag) {
        case "SwitchAgent":
          yield* handle
            .switchAgent(command.agent)
            .pipe(
              Effect.catchEager((error) =>
                cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )
          return

        case "Cancel":
        case "Interrupt":
          if (
            projectedState._tag === "Running" ||
            projectedState._tag === "WaitingForInteraction"
          ) {
            yield* handle.interrupt.pipe(
              Effect.catchEager((error) =>
                cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )
            return
          }
          const loopState = yield* handle.snapshot
          if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
            yield* handle.interrupt.pipe(
              Effect.catchEager((error) =>
                cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )
          }
          return

        case "Interject": {
          const interjectMessage = Message.cases.interjection.make({
            id: interjectionMessageIdForCommand(commandId),
            sessionId: command.sessionId,
            branchId: command.branchId,
            role: "user",
            parts: [Prompt.textPart({ text: command.message })],
            createdAt: yield* DateTime.nowAsDate,
          })
          const item: QueuedTurnItem = {
            message: interjectMessage,
            ...(command.agent !== undefined ? { agentOverride: command.agent } : {}),
          }
          const loopState = yield* handle.appendSteering(item)
          const shouldInterrupt = projectedState._tag === "Running" || loopState._tag === "Running"
          if (shouldInterrupt) {
            yield* handle.interruptActiveStream
          }
          return
        }
      }
    })

    return AgentLoop.of({
      Submit: Effect.fn("AgentLoop.Submit")(({ operation }: HandlerRequest<TurnSubmissionInput>) =>
        submitTurn(operation).pipe(provideActorWorkspace),
      ),
      SubmitDurable: Effect.fn("AgentLoop.SubmitDurable")(
        ({ operation }: HandlerRequest<TurnSubmissionInput>) =>
          submitTurn(operation).pipe(provideActorWorkspace),
      ),
      Run: Effect.fn("AgentLoop.Run")(({ operation }: HandlerRequest<TurnSubmissionInput>) =>
        runTurn(operation).pipe(provideActorWorkspace),
      ),
      QueueFollowUp: Effect.fn("AgentLoop.QueueFollowUp")(function* ({
        operation,
      }: HandlerRequest<TurnSubmissionInput>) {
        yield* Effect.gen(function* () {
          const handle = yield* ensureStarted
          yield* enqueueMessage(handle, {
            message: operation.message,
            agentOverride: operation.agentOverride,
            runSpec: operation.runSpec,
            interactive: operation.interactive,
          })
        }).pipe(provideActorWorkspace)
      }),
      Steer: Effect.fn("AgentLoop.Steer")(({ operation }: HandlerRequest<SteerInput>) =>
        applySteer(operation.commandId, operation.command).pipe(provideActorWorkspace),
      ),
      Interrupt: Effect.fn("AgentLoop.Interrupt")(function* ({
        operation,
      }: HandlerRequest<InterruptInput>) {
        const command = yield* Schema.decodeUnknownEffect(SteerCommand)({
          _tag: "Cancel",
          sessionId: operation.sessionId,
          branchId: operation.branchId,
          requestId: operation.commandId,
        }).pipe(
          Effect.mapError(
            (cause) => new AgentLoopError({ message: "Invalid interrupt command", cause }),
          ),
        )
        yield* applySteer(operation.commandId, command).pipe(provideActorWorkspace)
      }),
      RespondInteraction: Effect.fn("AgentLoop.RespondInteraction")(function* ({
        operation,
      }: HandlerRequest<RespondInteractionInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          const projectedState = yield* currentRuntimeState(handle)
          if (projectedState._tag !== "WaitingForInteraction") {
            const state = yield* handle.snapshot
            if (state._tag !== "WaitingForInteraction") {
              if (state._tag !== "Idle") return
              const message = yield* latestIncompleteUserTurn
              if (message === undefined) return
              const baseline = (yield* handle.readState).stateEpoch
              yield* handle
                .startTurn({ message })
                .pipe(
                  Effect.catchEager((error) =>
                    cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
                  ),
                )
              yield* Effect.raceFirst(
                waitForIdleAfterEpoch(handle, baseline),
                waitForTurnFailureAfterEpoch(handle, baseline),
              )
              return
            }
          }
          yield* handle
            .respondInteraction(operation.requestId)
            .pipe(
              Effect.catchEager((error) =>
                cleanupLoop(handle).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )
        }).pipe(provideActorWorkspace)
      }),
      DrainQueue: Effect.fn("AgentLoop.DrainQueue")(function* ({
        operation,
      }: HandlerRequest<DrainQueueInput>) {
        return yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          return yield* handle.drainQueue
        }).pipe(provideActorWorkspace)
      }),
      GetQueue: Effect.fn("AgentLoop.GetQueue")(function* ({
        operation,
      }: HandlerRequest<GetQueueInput>) {
        return yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* rejectIfTerminated
          const handle = yield* ensureStarted
          return yield* handle.queueSnapshot
        }).pipe(provideActorWorkspace)
      }),
      GetState: Effect.fn("AgentLoop.GetState")(function* ({
        operation,
      }: HandlerRequest<GetStateInput>) {
        return yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* rejectIfTerminated
          const handle = yield* ensureStarted
          return yield* handle.runtimeState
        }).pipe(provideActorWorkspace)
      }),
      RecordToolResult: Effect.fn("AgentLoop.RecordToolResult")(function* ({
        operation,
      }: HandlerRequest<RecordToolResultInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          yield* recordToolResult({
            toolResultMessageId:
              operation.commandId !== undefined
                ? toolResultMessageIdForCommand(operation.commandId)
                : toolResultMessageIdForToolCall(operation.toolCallId),
            sessionId: operation.sessionId,
            branchId: operation.branchId,
            toolCallId: operation.toolCallId,
            toolName: operation.toolName,
            output: operation.output,
            ...(operation.isError !== undefined ? { isError: operation.isError } : {}),
          }).pipe(handle.withSideMutation)
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))),
          provideActorWorkspace,
        )
      }),
      InvokeTool: Effect.fn("AgentLoop.InvokeTool")(function* ({
        operation,
      }: HandlerRequest<InvokeToolInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* markWrite
          const handle = yield* ensureStarted
          yield* Effect.gen(function* () {
            const currentTurnAgent = (yield* currentRuntimeState(handle)).agent
            const environment = yield* handle.resolveTurnProfile
            yield* invokeTool({
              assistantMessageId: assistantMessageIdForCommand(operation.commandId),
              toolResultMessageId: toolResultMessageIdForCommand(operation.commandId),
              toolCallId: toolCallIdForCommand(operation.commandId),
              toolName: operation.toolName,
              input: operation.input,
              sessionId: operation.sessionId,
              branchId: operation.branchId,
              currentTurnAgent,
            }).pipe(provideAgentLoopTurnProfile(environment))
          }).pipe(handle.withSideMutation)
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))),
          provideActorWorkspace,
        )
      }),
      TerminateBranch: Effect.fn("AgentLoop.TerminateBranch")(function* ({
        operation,
      }: HandlerRequest<TerminateBranchInput>) {
        yield* Effect.gen(function* () {
          yield* ensureTarget(operation)
          yield* sessionGovernance.markTerminated(workspaceId, sessionId)
          // Lifecycle stop must not depend on the loop being open. If the
          // mailbox closed before we got here, `handleRef` may be empty;
          // skip cleanup in that case rather than triggering a rebuild
          // via `ensureStarted`.
          const handle = yield* Ref.get(handleRef)
          if (handle !== undefined) {
            yield* cleanupLoop(handle)
          }
        }).pipe(provideActorWorkspace)
      }),
    })
  })
