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
 * - `QueueFollowUp` — `message.id` (live-only)
 * - `Steer` — `commandId` (persisted; actor owns request idempotency)
 * - `Interrupt` / `RespondInteraction` — durable persisted command key
 *
 * Schemas reuse gent's existing domain (`Message`, `RunSpec`,
 * `SteerCommand`) rather than introducing a parallel envelope shape.
 *
 * @module
 */

import {
  Cause,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
  Scope,
  Stream,
  Semaphore,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Actor } from "effect-encore"
import { type AgentName, type RunSpec } from "../../domain/agent.js"
import type { ModelId } from "../../domain/model.js"
import { Message, type MessageMetadata } from "../../domain/message.js"

const isActiveLoopState = Predicate.or(
  Predicate.isTagged("Running"),
  Predicate.isTagged("WaitingForInteraction"),
)
import {
  MessageId,
  RpcId,
  type ActorCommandId,
  type BranchId,
  type SessionId,
} from "../../domain/ids.js"
import { GentPlatform } from "../gent-platform.js"
import { CurrentWorkspaceId } from "../../server/workspace-rpc.js"
import type { PromptSection } from "../../domain/prompt.js"
import { SessionProfileCache } from "../session-profile.js"
import { interjectionMessageIdForCommand } from "./agent-loop.utils.js"
import {
  AgentLoopError,
  emptyLoopQueueState,
  projectRuntimeState,
  queueRequestsWake,
  type QueuedTurnItem,
  type ModelContextMetrics,
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
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import type { CapabilityError, CapabilityNotFoundError } from "../../domain/capability.js"
import { parseEntityId } from "./agent-loop.entity-id.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { runAgentLoopTurnProfile, type AgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import type { CurrentExtensionHostContext } from "./current-extension-host-context.js"
import { awaitTurnCompletion, turnFailureBaseline } from "./agent-loop.actor-state.js"
import {
  AgentLoop,
  type BranchCommandInput,
  type HandlerRequest,
  type MessageType,
  type RemoveFollowUpInput,
  type RequestExtensionInput,
  followUpMessageIdForSource,
  type QueueFollowUpInput,
  type RespondInteractionInput,
  type SteerCommandType,
  type SteerInput,
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
    const actorScope = yield* Effect.scope
    const sideMutationSemaphore = yield* Semaphore.make(1)
    // Set by admissions that run under the side-mutation permit. The wake runs
    // after the permit is released, so admission never starts a turn re-entrantly.
    const wakeRequested = yield* Ref.make(false)
    // Serializes per-entity `handle` rebuild. The actor mailbox is
    // `concurrency: "unbounded"`, so concurrent ops can both observe a
    // closed loop and race into `openLoop`, leaking the first behavior's
    // fibers and producing torn reads of `handle`/`startupExit`.
    const startupSemaphore = yield* Semaphore.make(1)
    const sessionGovernance = yield* AgentLoopSessionGovernance
    const platform = yield* GentPlatform
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
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
    const operations = yield* SessionOperationStorage
    const sessionProfileCacheOption = yield* Effect.serviceOption(SessionProfileCache)
    const closed = yield* Ref.make(false)
    const operationSeen = yield* Ref.make(false)

    type ExtensionRequestEffect = Effect.Effect<
      unknown,
      CapabilityError | CapabilityNotFoundError,
      CurrentExtensionHostContext | FileSystem.FileSystem | Path.Path
    >

    const extensionRequestError = (
      error: AgentLoopError | CapabilityError | CapabilityNotFoundError,
    ): AgentLoopError => {
      if (Schema.is(AgentLoopError)(error)) return error
      let message: string = error._tag
      if ("reason" in error) message = `${error._tag}: ${error.reason}`
      return new AgentLoopError({ message, cause: error })
    }

    const runExtensionRequest = (
      environment: AgentLoopTurnProfile,
      requestEffect: ExtensionRequestEffect,
    ) =>
      requestEffect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        runAgentLoopTurnProfile(environment),
        Effect.mapError(extensionRequestError),
      )

    // `handle` and `startupExit` were plain `let` bindings before C13.1. The
    // mailbox runs at `concurrency: "unbounded"`, so the post-flip window in
    // `openLoop` between `Ref.set(closed, false)` and the assignment of
    // `handle`/`startupExit` was racing: a fiber arriving via `ensureStarted`
    // could observe `closed=false`, skip the rebuild branch, and then read
    // a stale (now-closed) handle. Promoted to `Ref` and all reads happen
    // inside `ensureStarted` (which holds `startupSemaphore` across the
    // rebuild, the post-check, and the published handle return).
    const handleRef = yield* Ref.make<Option.Option<AgentLoopBehavior>>(Option.none())
    const startupExitRef = yield* Ref.make<Option.Option<Exit.Exit<void, AgentLoopError>>>(
      Option.none(),
    )

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

    /** A failed behavior call closes the loop before the error reaches the caller. */
    const orCleanup =
      (handle: AgentLoopBehavior) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        effect.pipe(
          Effect.catchEager((error) =>
            closeBehavior(handle).pipe(Effect.andThen(Effect.fail(error))),
          ),
        )

    // Typed reentrant-only handle lookup. The only legitimate caller is the
    // `AgentLoopFollowUp` enqueue implementation provided to the behavior — it
    // fires from inside the behavior itself (during turn execution), so the
    // handle is provably published into `handleRef` by then. Mailbox handlers
    // (which arrive from outside the behavior) MUST go through `ensureStarted`
    // instead — that path holds `startupSemaphore` across the rebuild/publish,
    // ensuring no one observes a half-reopened loop.
    const reentrantHandle = Effect.gen(function* () {
      const value = yield* Ref.get(handleRef)
      if (Option.isNone(value)) {
        return yield* new AgentLoopError({
          message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
        })
      }
      return value.value
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
        envelopes.flatMap((envelope) => {
          if (
            envelope.event._tag === "TurnCompleted" &&
            !Predicate.isUndefined(envelope.event.messageId)
          ) {
            return [envelope.event.messageId]
          }
          return []
        }),
      )
      // Continuation prompts belong to the turn that persisted them; they
      // never complete on their own and must not start a turn of their own.
      const incomplete = envelopes.filter(
        (envelope) =>
          envelope.event._tag === "MessageReceived" &&
          envelope.event.message.role === "user" &&
          envelope.event.message.metadata?.customType !== "continuation" &&
          !completed.has(envelope.event.message.id),
      )
      const latest = Option.fromUndefinedOr(incomplete[incomplete.length - 1])
      if (Option.isNone(latest) || latest.value.event._tag !== "MessageReceived") {
        return Option.none()
      }
      return Option.some(latest.value.event.message)
    })

    const hasIncompleteUserTurn = latestIncompleteUserTurn.pipe(Effect.map(Option.isSome))

    const startNextQueuedTurnIfIdle = (
      handle: AgentLoopBehavior,
      options?: { readonly startupPermitHeld?: boolean },
    ) =>
      Effect.gen(function* () {
        const start = yield* handle.takeNextQueuedTurnIfIdle
        if (Option.isSome(start)) {
          yield* handle.startTurn(start.value).pipe(
            Effect.catchEager((error) => {
              let cleanup = closeBehavior
              const startupPermitHeld = Option.fromUndefinedOr(options).pipe(
                Option.map(({ startupPermitHeld: held }) => held),
              )
              if (Option.isSome(startupPermitHeld) && startupPermitHeld.value === true) {
                cleanup = closeBehaviorWithHeldStartupPermit
              }
              return cleanup(handle).pipe(Effect.andThen(Effect.fail(error)))
            }),
          )
        }
      })

    const markWrite = Effect.gen(function* () {
      if (yield* sessionGovernance.isTerminated(workspaceId, sessionId)) {
        return yield* new AgentLoopError({
          message: `Session runtime terminated: ${sessionId}`,
        })
      }
      return yield* Ref.modify(operationSeen, (seen) => [seen, true])
    })

    const rejectIfTerminated = Effect.gen(function* () {
      if (yield* sessionGovernance.isTerminated(workspaceId, sessionId)) {
        return yield* new AgentLoopError({
          message: `Session terminated: ${sessionId}`,
        })
      }
    })

    const ensureTarget = (target: {
      readonly sessionId: SessionId
      readonly branchId: BranchId
    }) => {
      if (target.sessionId === sessionId && target.branchId === branchId) {
        return Effect.void
      }
      return Effect.fail(
        new AgentLoopError({
          message: `AgentLoop op target mismatch: entity=${sessionId}/${branchId} payload=${target.sessionId}/${target.branchId}`,
        }),
      )
    }

    /** One branch command on the started loop: check the target, apply the guard, run. */
    const branchCommand = <A, E, R>(
      operation: BranchCommandInput,
      guard: Effect.Effect<unknown, AgentLoopError>,
      run: (handle: AgentLoopBehavior) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        yield* ensureTarget(operation)
        yield* guard
        const handle = yield* ensureStarted
        return yield* run(handle)
      }).pipe(provideActorWorkspace)

    // Both call sites supply an already-resolved `handle`:
    //   - the `AgentLoopFollowUp` enqueue implementation reads
    //     `reentrantHandle` lazily — it fires during turn execution (well
    //     after `openLoop` published `handleRef`), so the read is provably safe.
    //   - the `QueueFollowUp` mailbox handler resolves it via `ensureStarted`.
    // Taking it as a parameter eliminates the implicit two-step contract
    // that previously bypassed `ensureStarted` for non-reentrant callers.
    type FollowUpInput = {
      /** Keys the message id so repeated admissions and later removal target one item. */
      readonly sourceId?: string
      readonly message?: MessageType
      readonly content?: string
      readonly metadata?: MessageMetadata
      readonly agentOverride?: AgentName
      readonly runSpec?: RunSpec
      readonly interactive?: boolean
      readonly wake?: boolean
    }

    const buildFollowUpItem = Effect.fn("AgentLoopActor.buildFollowUpItem")(function* (
      input: FollowUpInput,
    ) {
      const platformRandomId = yield* platform.randomId
      const message =
        input.message ??
        Message.cases.regular.make({
          id: Option.match(Option.fromUndefinedOr(input.sourceId), {
            onNone: () => MessageId.make(platformRandomId),
            onSome: (sourceId) =>
              followUpMessageIdForSource({
                workspaceId: brandedWorkspaceId,
                sessionId,
                branchId,
                sourceId,
              }),
          }),
          sessionId,
          branchId,
          role: "user",
          parts: [Prompt.textPart({ text: input.content ?? "" })],
          createdAt: yield* DateTime.nowAsDate,
          metadata: input.metadata,
        })
      yield* ensureTarget(message)
      const item: QueuedTurnItem = {
        message,
        agentOverride: input.agentOverride,
        runSpec: input.runSpec,
        interactive: input.interactive,
        wake: input.wake,
      }
      return item
    })

    /**
     * Re-entrant admission: the caller already holds the side-mutation permit
     * (a running turn, a tool invocation, or an extension request). The item is
     * queued durably here; the turn starts after the permit is released.
     */
    const admitFollowUp = Effect.fn("AgentLoopActor.admitFollowUp")(function* (
      handle: AgentLoopBehavior,
      input: FollowUpInput,
    ) {
      yield* markWrite
      const item = yield* buildFollowUpItem(input)
      yield* handle.reserveStartOrQueueFollowUp(item, { queueOnly: true })
      const shouldWake =
        input.wake === true || (yield* hasIncompleteUserTurn) || (yield* hasPriorMessageHistory)
      if (shouldWake) {
        yield* Ref.set(wakeRequested, true)
        // A retained facade can enqueue after its original turn has ended.
        // The actor owns this wake; an active mutation releases its permit first.
        yield* drainWake(handle).pipe(provideActorWorkspace, Effect.forkIn(actorScope))
      }
    })

    const enqueueMessage = Effect.fn("AgentLoopActor.enqueueMessage")(function* (
      handle: AgentLoopBehavior,
      input: FollowUpInput,
    ) {
      const wasAlreadyWarm = yield* markWrite
      const item = yield* buildFollowUpItem(input)
      const reservedStart = yield* handle.reserveStartOrQueueFollowUp(item, {
        queueOnly: !wasAlreadyWarm,
      })
      if (Option.isSome(reservedStart)) {
        yield* handle.startTurn(item).pipe(orCleanup(handle))
      }
      if (!wasAlreadyWarm) {
        if (
          input.wake === true ||
          (yield* hasIncompleteUserTurn) ||
          (yield* hasPriorMessageHistory)
        ) {
          yield* startNextQueuedTurnIfIdle(handle)
        }
        return
      }
    })

    /** Start a queued turn requested by a re-entrant admission once the permit is free. */
    const drainWake = (handle: AgentLoopBehavior) =>
      Effect.gen(function* () {
        if (!(yield* Ref.getAndSet(wakeRequested, false))) return
        yield* startNextQueuedTurnIfIdle(handle)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to start a queued turn after admission").pipe(
            Effect.annotateLogs({ sessionId, branchId, error: Cause.pretty(cause) }),
          ),
        ),
      )

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
      let initialQueue = emptyLoopQueueState()
      let initialQueueFailure = Option.none<AgentLoopError>()
      if (Exit.isSuccess(initialQueueExit)) {
        initialQueue = initialQueueExit.value
      } else {
        initialQueueFailure = Option.some(
          new AgentLoopError({
            message: `Failed to load loop queue for ${sessionId}/${branchId}`,
            cause: initialQueueExit.cause,
          }),
        )
      }
      if (Option.isSome(initialQueueFailure)) {
        yield* Effect.logWarning("failed to load loop queue").pipe(
          Effect.annotateLogs({
            sessionId,
            branchId,
            error: initialQueueFailure.value.message,
          }),
        )
      }
      // Each rebuild owns a child of the actor scope, never the request scope.
      // Transfer it only after construction and handle publication both succeed.
      const handle = yield* Effect.acquireUseRelease(
        Scope.fork(actorScope),
        (loopScope) =>
          makeAgentLoopBehavior(
            sessionId,
            branchId,
            sideMutationSemaphore,
            config.baseSections,
            initialQueue,
            Option.getOrUndefined(sessionProfileCacheOption),
          ).pipe(
            Effect.provideService(AgentLoopFollowUp, {
              enqueue: (input) =>
                reentrantHandle.pipe(Effect.flatMap((h) => admitFollowUp(h, input))),
              dequeue: (input) =>
                reentrantHandle.pipe(
                  Effect.flatMap((h) =>
                    h.removeFollowUp(
                      followUpMessageIdForSource({ workspaceId: brandedWorkspaceId, ...input }),
                    ),
                  ),
                ),
            }),
            Scope.provide(loopScope),
            Effect.tap((handle) => Ref.set(handleRef, Option.some(handle))),
          ),
        (loopScope, exit) => {
          if (Exit.isFailure(exit)) return Scope.close(loopScope, exit)
          return Effect.void
        },
      )
      if (Option.isSome(initialQueueFailure)) {
        yield* Ref.set(startupExitRef, Option.some(Exit.fail(initialQueueFailure.value)))
        yield* Ref.set(closed, false)
        return
      }

      const exit = yield* Effect.exit(
        handle.start.pipe(
          Effect.andThen(handle.refreshRuntimeState),
          Effect.andThen(
            Effect.gen(function* () {
              const incompleteMessage = yield* latestIncompleteUserTurn
              if (Option.isSome(incompleteMessage)) {
                yield* handle
                  .startTurn({ message: incompleteMessage.value })
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
                !Predicate.isUndefined(initialQueue.inFlight) ||
                initialQueue.steering.length > 0 ||
                initialQueue.followUp.length > 0
              if (!hasRecoveredQueue) return
              if (queueRequestsWake(initialQueue) || (yield* hasPriorMessageHistory)) {
                yield* startNextQueuedTurnIfIdle(handle, { startupPermitHeld: true })
              }
            }),
          ),
        ),
      )
      yield* Ref.set(startupExitRef, Option.some(exit))
      // Publish `closed=false` only after both `handleRef` and
      // `startupExitRef` are visible. `ensureStarted` reads `closed`
      // before reading the handle/exit, so flipping it last guarantees a
      // fiber that sees `closed=false` will read the freshly-published
      // pair, not a stale one from a previous open cycle.
      yield* Ref.set(closed, false)
    })

    yield* openLoop.pipe(provideActorWorkspace)
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(handleRef), (loop) => {
        if (Option.isNone(loop)) return Effect.void
        return closeBehavior(loop.value)
      }),
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
      if (Option.isNone(exit) || Exit.isSuccess(exit.value)) {
        const handle = yield* Ref.get(handleRef)
        if (Option.isNone(handle)) {
          return yield* new AgentLoopError({
            message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
          })
        }
        return handle.value
      }
      return yield* causeToAgentLoopError(exit.value.cause)
    }).pipe(startupSemaphore.withPermits(1))

    const currentRegisteredState = Effect.gen(function* () {
      yield* rejectIfTerminated
      const handle = yield* ensureStarted
      return yield* handle.runtimeState
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

    const registeredState = Actor.State.makeReadable(
      currentRegisteredState.pipe(provideActorWorkspace),
      registeredStateChanges.pipe(Stream.provideService(CurrentWorkspaceId, brandedWorkspaceId)),
    )
    yield* Actor.registerState(registeredState)

    /** A message whose turn already ran is not a new turn; a retried submit sees it done. */
    const turnAlreadyCompleted = (messageId: MessageId) =>
      messageStorage.getMessage(messageId).pipe(
        Effect.map((message) => Predicate.isNotUndefined(message?.turnDurationMs)),
        Effect.mapError(
          (cause) => new AgentLoopError({ message: "Cannot read submitted message", cause }),
        ),
      )

    /**
     * Admit one submitted turn: target check, warm mark, reservation, and the
     * start when the reservation grants it. Returns the reservation so the
     * caller can wait on what it was granted.
     */
    const admitTurn = <Reserved>(
      handle: AgentLoopBehavior,
      operation: TurnSubmissionInput,
      reserve: (item: QueuedTurnItem) => Effect.Effect<Option.Option<Reserved>, AgentLoopError>,
    ) =>
      Effect.gen(function* () {
        yield* ensureTarget(operation.message)
        yield* markWrite
        if (yield* turnAlreadyCompleted(operation.message.id)) return Option.none<Reserved>()
        const item: QueuedTurnItem = {
          message: operation.message,
          agentOverride: operation.agentOverride,
          runSpec: operation.runSpec,
          interactive: operation.interactive,
        }
        const reserved = yield* reserve(item)
        if (Option.isSome(reserved)) yield* handle.startTurn(item).pipe(orCleanup(handle))
        return reserved
      })

    const reserveStart = (handle: AgentLoopBehavior) => (item: QueuedTurnItem) =>
      handle.reserveStartOrQueueFollowUp(item, { queueOnly: false })

    const submitTurn = Effect.fn("AgentLoopActor.submitTurn")(function* (
      operation: TurnSubmissionInput,
    ) {
      const handle = yield* ensureStarted
      yield* admitTurn(handle, operation, reserveStart(handle))
    })

    const submitTurnAndWait = Effect.fn("AgentLoopActor.submitTurnAndWait")(function* (
      operation: TurnSubmissionInput,
    ) {
      const handle = yield* ensureStarted
      const baseline = yield* turnFailureBaseline(handle)
      yield* admitTurn(handle, operation, reserveStart(handle))
      // This turn is done when the loop lets *its* message go, which can
      // happen while the loop stays busy with a follow-up.
      yield* awaitTurnCompletion(handle, baseline, operation.message.id).pipe(orCleanup(handle))
    })

    const isCancellation = Predicate.or(
      Predicate.isTagged("Cancel"),
      Predicate.isTagged("Interrupt"),
    )

    const applySteer = Effect.fn("AgentLoopActor.applySteer")(function* (
      commandId: ActorCommandId,
      command: SteerCommandType,
    ) {
      yield* ensureTarget(command)
      yield* markWrite
      if (isCancellation(command) && Predicate.isNotUndefined(command.messageId)) {
        yield* operations.cancelTurn({ sessionId, branchId, messageId: command.messageId }).pipe(
          Effect.mapError(
            (cause) =>
              new AgentLoopError({
                message: "Cannot record targeted cancellation",
                cause,
              }),
          ),
        )
      }
      const handle = yield* ensureStarted
      const projectedState = yield* handle.runtimeState

      switch (command._tag) {
        case "SwitchAgent":
          yield* handle.switchAgent(command.agent).pipe(orCleanup(handle))
          return

        case "Cancel":
        case "Interrupt":
          if (isActiveLoopState(projectedState)) {
            yield* handle.interrupt(command.messageId).pipe(orCleanup(handle))
            return
          }
          const loopState = yield* handle.snapshot
          if (isActiveLoopState(loopState)) {
            yield* handle.interrupt(command.messageId).pipe(orCleanup(handle))
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
            agentOverride: command.agent,
          }
          // Steering joins the running turn at its next step boundary, or starts
          // the next turn when the loop is idle. The open stream is not interrupted.
          yield* handle.appendSteering(item)
          return
        }
      }
    })

    return AgentLoop.of({
      Submit: Effect.fn("AgentLoop.Submit")(({ operation }: HandlerRequest<TurnSubmissionInput>) =>
        submitTurn(operation).pipe(provideActorWorkspace),
      ),
      SubmitAndWait: Effect.fn("AgentLoop.SubmitAndWait")(
        ({ operation }: HandlerRequest<TurnSubmissionInput>) =>
          submitTurnAndWait(operation).pipe(provideActorWorkspace),
      ),
      // Same body as `Submit` by design. `persisted` is a static RPC
      // annotation compiled into the protocol, not a payload field, so the
      // durable variant has to be its own operation. Do not merge the two.
      SubmitDurable: Effect.fn("AgentLoop.SubmitDurable")(
        ({ operation }: HandlerRequest<TurnSubmissionInput>) =>
          submitTurn(operation).pipe(provideActorWorkspace),
      ),
      QueueFollowUp: Effect.fn("AgentLoop.QueueFollowUp")(
        ({ operation }: HandlerRequest<QueueFollowUpInput>) =>
          Effect.gen(function* () {
            const handle = yield* ensureStarted
            yield* enqueueMessage(handle, {
              message: operation.message,
              wake: operation.wake,
            })
          }).pipe(provideActorWorkspace),
      ),
      Steer: Effect.fn("AgentLoop.Steer")(({ operation }: HandlerRequest<SteerInput>) =>
        applySteer(operation.commandId, operation.command).pipe(provideActorWorkspace),
      ),
      RespondInteraction: Effect.fn("AgentLoop.RespondInteraction")(
        ({ operation }: HandlerRequest<RespondInteractionInput>) =>
          Effect.gen(function* () {
            yield* ensureTarget(operation)
            yield* markWrite
            const handle = yield* ensureStarted
            const projectedState = yield* handle.runtimeState
            if (projectedState._tag !== "WaitingForInteraction") {
              const state = yield* handle.snapshot
              if (state._tag !== "WaitingForInteraction") {
                if (state._tag !== "Idle") return
                const message = yield* latestIncompleteUserTurn
                if (Option.isNone(message)) return
                const baseline = yield* turnFailureBaseline(handle)
                yield* handle.startTurn({ message: message.value }).pipe(orCleanup(handle))
                yield* awaitTurnCompletion(handle, baseline, message.value.id)
                return
              }
            }
            yield* handle.respondInteraction(operation.requestId).pipe(orCleanup(handle))
          }).pipe(provideActorWorkspace),
      ),
      DrainQueue: Effect.fn("AgentLoop.DrainQueue")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          branchCommand(operation, markWrite, (handle) => handle.drainQueue),
      ),
      RemoveFollowUp: Effect.fn("AgentLoop.RemoveFollowUp")(
        ({ operation }: HandlerRequest<RemoveFollowUpInput>) =>
          branchCommand(operation, markWrite, (handle) =>
            handle.removeFollowUp(operation.messageId),
          ),
      ),
      GetQueue: Effect.fn("AgentLoop.GetQueue")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          branchCommand(operation, rejectIfTerminated, (handle) => handle.queueSnapshot),
      ),
      GetState: Effect.fn("AgentLoop.GetState")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          branchCommand(operation, rejectIfTerminated, (handle) => handle.runtimeState),
      ),
      GetMetrics: Effect.fn("AgentLoop.GetMetrics")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          Effect.gen(function* () {
            yield* ensureTarget(operation)
            yield* rejectIfTerminated
            const envelopes = yield* eventStorage
              .listEvents({ sessionId: operation.sessionId, branchId: operation.branchId })
              .pipe(Effect.catchEager(() => Effect.succeed([])))
            let turns = 0
            let durationMs = 0
            let costUsd = 0
            let lastInputTokens = 0
            let lastModelId = Option.none<ModelId>()
            let compactions = 0
            let context = Option.none<ModelContextMetrics>()
            for (const { event } of envelopes) {
              switch (event._tag) {
                case "TurnCompleted":
                  turns++
                  durationMs += event.durationMs
                  break
                case "ModelContextProjected":
                  if (event.compacted) compactions++
                  context = Option.some({
                    estimatedTokens: event.estimatedTokens,
                    availableInputTokens: event.availableInputTokens,
                    contextLimitTokens: event.contextLimitTokens,
                    omittedMessages: event.omittedMessages,
                    compactedRevision: event.compactedRevision,
                    compactions,
                  })
                  break
                case "StreamEnded":
                  if (!Predicate.isUndefined(event.usage)) {
                    lastInputTokens = event.usage.inputTokens
                  }
                  if (!Predicate.isUndefined(event.costUsd)) {
                    costUsd += event.costUsd
                  }
                  if (!Predicate.isUndefined(event.model)) {
                    lastModelId = Option.some(event.model)
                  }
                  break
              }
            }
            const metrics = {
              turns,
              durationMs,
              costUsd,
              lastInputTokens,
            }
            if (Option.isSome(lastModelId))
              Object.assign(metrics, { lastModelId: lastModelId.value })
            if (Option.isSome(context)) Object.assign(metrics, { context: context.value })
            return metrics
          }).pipe(provideActorWorkspace),
      ),
      RequestExtension: Effect.fn("AgentLoop.RequestExtension")(
        ({ operation }: HandlerRequest<RequestExtensionInput>) =>
          Effect.gen(function* () {
            yield* ensureTarget(operation)
            const handle = yield* ensureStarted
            const environment = yield* handle.resolveTurnProfile
            const rpcRegistry = environment.turnExtensionRegistry.getResolved().rpcRegistry
            const capabilityId = RpcId.make(operation.capabilityId)
            let input: unknown = Option.getOrUndefined(Option.none())
            if (operation.input._tag === "Present") input = operation.input.value
            const run = runExtensionRequest(
              environment,
              rpcRegistry.run(operation.extensionId, capabilityId, input),
            ).pipe(
              // Branch Resources live on the loop scope, not on the turn
              // profile. Without this an extension leaf reached over RPC
              // cannot see a `scope: "branch"` service.
              Effect.provideContext(handle.branchContext),
            )
            // A read-only request answers while a turn runs; anything else is
            // a side mutation and waits for the permit the turn holds.
            if (rpcRegistry.isReadonly(operation.extensionId, capabilityId)) return yield* run
            return yield* run.pipe(handle.withSideMutation, Effect.ensuring(drainWake(handle)))
          }).pipe(
            Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))),
            provideActorWorkspace,
          ),
      ),
      TerminateBranch: Effect.fn("AgentLoop.TerminateBranch")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          Effect.gen(function* () {
            yield* ensureTarget(operation)
            yield* sessionGovernance.markTerminated(workspaceId, sessionId)
            // Lifecycle stop must not depend on the loop being open. If the
            // mailbox closed before we got here, `handleRef` may be empty;
            // skip cleanup in that case rather than triggering a rebuild
            // via `ensureStarted`.
            const handle = yield* Ref.get(handleRef)
            if (Option.isSome(handle)) {
              yield* closeBehavior(handle.value)
            }
          }).pipe(provideActorWorkspace),
      ),
    })
  })
