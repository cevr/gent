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
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
  Semaphore,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { ShardingConfig } from "effect/unstable/cluster"
import { Actor } from "effect-encore"
import { type AgentName, type RunSpec } from "../../domain/agent.js"
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
  turnFailureEpoch,
  type AgentLoopState,
  type LoopState,
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
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import type { CapabilityError, CapabilityNotFoundError } from "../../domain/capability.js"
import { parseEntityId } from "./agent-loop.entity-id.js"
import { ProcessLocalToolReplay } from "./process-local-tool-replay.js"
import { AgentLoopSessionGovernance } from "./agent-loop.session-governance.js"
import { runAgentLoopTurnProfile, type AgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import type { CurrentExtensionHostContext } from "./current-extension-host-context.js"
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
 * When a turn is finished, told from the outside.
 *
 * A turn is over when the loop no longer holds its message: not starting it,
 * not running it, not waiting on it, and not keeping it queued. That is read
 * off the loop's own state, so no event subscription can miss it. Failure is
 * a monotonic counter (`turnFailure.epoch`); a caller records where it stood
 * before starting the turn (`turnFailureBaseline`) and a later mark is this
 * turn's failure.
 */

const stateHoldsMessage = (state: LoopState, messageId: MessageId) =>
  state._tag !== "Idle" && state.message.id === messageId

const BehaviorHandle = Schema.declare<AgentLoopBehavior>((value): value is AgentLoopBehavior =>
  Predicate.hasProperty(value, "awaitExit"),
)

/**
 * Where one entity's loop stands.
 *
 * The three facts a caller needs — is there a handle, did startup fail, and
 * does the next op have to rebuild — are one value, so no ordering between
 * them is possible and the illegal combinations cannot be written.
 *
 * `Building` is the state before the first `openLoop` publishes anything, the
 * only one with no handle. `Closed` keeps its handle because a close is not a
 * teardown: the finalizer and `TerminateBranch` close the behavior they last
 * held, and the next op rebuilds over it.
 */
const LoopLifecycle = Schema.TaggedUnion({
  Building: {},
  Open: { handle: BehaviorHandle },
  Failed: { handle: BehaviorHandle, error: AgentLoopError },
  Closed: { handle: BehaviorHandle },
})
type LoopLifecycle = Schema.Schema.Type<typeof LoopLifecycle>

/** The handle this state holds, if it has reached one. */
const lifecycleHandle = (lifecycle: LoopLifecycle): Option.Option<AgentLoopBehavior> => {
  if (lifecycle._tag === "Building") return Option.none()
  return Option.some(lifecycle.handle)
}

/** The loop still owns this message: starting, running, waiting, or queued. */
const holdsMessage = (s: AgentLoopState, messageId: MessageId): boolean => {
  const item = (queued: QueuedTurnItem) => queued.message.id === messageId
  return (
    stateHoldsMessage(s.state, messageId) ||
    (Predicate.isNotUndefined(s.startingState) && stateHoldsMessage(s.startingState, messageId)) ||
    (Predicate.isNotUndefined(s.queue.inFlight) && item(s.queue.inFlight)) ||
    s.queue.followUp.some(item) ||
    s.queue.steering.some(item)
  )
}

const waitForMessageReleased = (
  behavior: AgentLoopBehavior,
  messageId: MessageId,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (!holdsMessage(current, messageId)) return
    yield* behavior.stateChanges.pipe(
      Stream.filter((state) => !holdsMessage(state, messageId)),
      Stream.runHead,
    )
  })

const failTurnFailureState = (failure: NonNullable<AgentLoopState["turnFailure"]>) => {
  if (Schema.is(AgentLoopError)(failure.error)) return Effect.fail(failure.error)
  return Effect.fail(
    new AgentLoopError({ message: "Agent loop turn failed", cause: failure.error }),
  )
}

const waitForTurnFailureAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (Predicate.isNotUndefined(current.turnFailure) && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
    const hasNewTurnFailure = (
      state: AgentLoopState,
    ): state is AgentLoopState & {
      readonly turnFailure: NonNullable<AgentLoopState["turnFailure"]>
    } => Predicate.isNotUndefined(state.turnFailure) && state.turnFailure.epoch > baseline
    const next = yield* behavior.stateChanges.pipe(Stream.filter(hasNewTurnFailure), Stream.runHead)
    if (Option.isSome(next)) return yield* failTurnFailureState(next.value.turnFailure)
    return yield* new AgentLoopError({
      message: "Agent loop turn failure stream ended",
    })
  })

const failIfTurnFailedAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.readState
    if (Predicate.isNotUndefined(current.turnFailure) && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
  })

/** Record the failure mark to wait from. Take this *before* starting the turn. */
const turnFailureBaseline = (behavior: AgentLoopBehavior): Effect.Effect<number> =>
  Effect.map(behavior.readState, turnFailureEpoch)

/**
 * Wait until the loop has released `messageId`, started after `baseline`.
 *
 * It ends three ways, and all three end the wait: the loop lets the message
 * go (the turn ran, or a batch absorbed it), the turn fails, or persistence
 * fails. The last two fail the effect.
 */
const awaitTurnCompletion = (
  behavior: AgentLoopBehavior,
  baseline: number,
  messageId: MessageId,
): Effect.Effect<void, AgentLoopError> =>
  Effect.raceFirst(
    Effect.raceFirst(
      waitForMessageReleased(behavior, messageId),
      waitForTurnFailureAfterEpoch(behavior, baseline),
    ),
    behavior.persistenceFailure,
  ).pipe(
    // Release wins the race even when the turn failed on its way there,
    // so the failure is checked once more after the race settles.
    Effect.andThen(failIfTurnFailedAfterEpoch(behavior, baseline)),
  )
/**
 * `Actor.toLayer` handler layer for `AgentLoop`.
 *
 * Per-(sessionId, branchId) loop ownership lives in the actor entity instance.
 * Encore exposes `CurrentAddress` while keeping that entity-provided service
 * out of the resulting layer requirements.
 */
const buildAgentLoopActorHandlers = (config: {
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
    const operations = yield* SessionOperationStorage
    const sessionProfileCacheOption = yield* Effect.serviceOption(SessionProfileCache)
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

    // Every read happens inside `ensureStarted`, which holds
    // `startupSemaphore` across the rebuild and the handle return, so no
    // caller can be handed a handle from a cycle that has since closed.
    const lifecycleRef = yield* Ref.make<LoopLifecycle>(LoopLifecycle.cases.Building.make({}))

    /** Close once. A second call finds `Closed` and leaves the behavior alone. */
    const closeBehaviorWithHeldStartupPermit = (loop: AgentLoopBehavior) =>
      Effect.gen(function* () {
        const closing = LoopLifecycle.cases.Closed.make({ handle: loop })
        const previous = yield* Ref.getAndSet(lifecycleRef, closing)
        if (previous._tag === "Closed") return
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

    /** Reserve the start for one item and run it when the reservation grants it. */
    const reserveAndStart = (
      handle: AgentLoopBehavior,
      item: QueuedTurnItem,
      options: { readonly queueOnly: boolean },
    ) =>
      Effect.gen(function* () {
        const reserved = yield* handle.reserveStartOrQueueFollowUp(item, options)
        if (Option.isSome(reserved)) yield* handle.startTurn(item).pipe(orCleanup(handle))
        return reserved
      })

    // Typed reentrant-only handle lookup. The only legitimate caller is the
    // `AgentLoopFollowUp` enqueue implementation provided to the behavior — it
    // fires from inside the behavior itself (during turn execution), so the
    // handle is provably published into `handleRef` by then. Mailbox handlers
    // (which arrive from outside the behavior) MUST go through `ensureStarted`
    // instead — that path holds `startupSemaphore` across the rebuild/publish,
    // ensuring no one observes a half-reopened loop.
    const reentrantHandle = Effect.gen(function* () {
      const value = lifecycleHandle(yield* Ref.get(lifecycleRef))
      if (Option.isNone(value)) {
        return yield* new AgentLoopError({
          message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
        })
      }
      return value.value
    })

    /** A cold loop wakes for an explicit ask, an unfinished turn, or any prior history. */
    const shouldWake = (handle: AgentLoopBehavior, input: { readonly wake?: boolean }) =>
      Effect.gen(function* () {
        if (input.wake === true) return true
        if (Option.isSome(yield* handle.incompleteUserTurn)) return true
        return yield* handle.hasPriorHistory
      })

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
      /** The message already carries a source-keyed id; see `QueuedTurnItem.keyed`. */
      readonly keyed?: boolean
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
        keyed: Predicate.isNotUndefined(input.sourceId) || input.keyed === true,
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
      if (yield* shouldWake(handle, input)) {
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
      yield* reserveAndStart(handle, item, { queueOnly: !wasAlreadyWarm })
      if (!wasAlreadyWarm && (yield* shouldWake(handle, input))) {
        yield* startNextQueuedTurnIfIdle(handle)
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
      const loadedQueue = yield* Effect.result(
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
      const initialQueue = Result.getOrElse(loadedQueue, emptyLoopQueueState)
      const initialQueueFailure = Result.getFailure(loadedQueue)
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
            // Published before startup runs: a turn recovered below can enqueue
            // a follow-up through `reentrantHandle` while startup is still in
            // flight. `ensureStarted` cannot see this state — it holds the
            // startup permit across the whole rebuild.
            Effect.tap((handle) =>
              Ref.set(lifecycleRef, LoopLifecycle.cases.Open.make({ handle })),
            ),
          ),
        (loopScope, exit) => {
          if (Exit.isFailure(exit)) return Scope.close(loopScope, exit)
          return Effect.void
        },
      )
      if (Option.isSome(initialQueueFailure)) {
        yield* Ref.set(
          lifecycleRef,
          LoopLifecycle.cases.Failed.make({ handle, error: initialQueueFailure.value }),
        )
        return
      }

      const exit = yield* Effect.exit(
        handle.start.pipe(
          Effect.andThen(handle.writeInitialQueue),
          Effect.andThen(
            Effect.gen(function* () {
              const incompleteMessage = yield* handle.incompleteUserTurn
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
              if (queueRequestsWake(initialQueue) || (yield* handle.hasPriorHistory)) {
                yield* startNextQueuedTurnIfIdle(handle, { startupPermitHeld: true })
              }
            }),
          ),
        ),
      )
      // One write settles the cycle: success leaves the published `Open`, and
      // a failure replaces it with the error every later op will be handed.
      // A startup that closed the behavior on its way out always fails too, so
      // `Failed` never hides a live loop.
      if (Exit.isFailure(exit)) {
        yield* Ref.set(
          lifecycleRef,
          LoopLifecycle.cases.Failed.make({
            handle,
            error: causeToAgentLoopError(exit.cause),
          }),
        )
      }
    })

    yield* openLoop.pipe(provideActorWorkspace)
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(lifecycleRef), (lifecycle) => {
        const loop = lifecycleHandle(lifecycle)
        if (Option.isNone(loop)) return Effect.void
        return closeBehavior(loop.value)
      }),
    )

    // Serialize the full read/rebuild/check path so concurrent ops cannot
    // observe a partially-rebuilt loop. The rebuild and the read share one
    // permit window, so the handle a caller is handed belongs to the cycle
    // this call just settled.
    const ensureStarted = Effect.gen(function* () {
      if ((yield* Ref.get(lifecycleRef))._tag === "Closed") {
        yield* openLoop.pipe(provideActorWorkspace)
      }
      // The rebuild above settles `Open` or `Failed`. The other two mean the
      // rebuild left no usable loop, and handing back a closed handle would
      // run the op against a behavior whose fibers are gone.
      const unavailable = Effect.fail(
        new AgentLoopError({
          message: `AgentLoop handle unavailable for ${sessionId}/${branchId}`,
        }),
      )
      return yield* Match.type<LoopLifecycle>().pipe(
        Match.tagsExhaustive({
          Open: ({ handle }) => Effect.succeed(handle),
          Failed: ({ error }) => Effect.fail(error),
          Closed: () => unavailable,
          Building: () => unavailable,
        }),
      )(yield* Ref.get(lifecycleRef))
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
     * start when the reservation grants it.
     */
    const admitTurn = (handle: AgentLoopBehavior, operation: TurnSubmissionInput) =>
      Effect.gen(function* () {
        yield* ensureTarget(operation.message)
        yield* markWrite
        if (yield* turnAlreadyCompleted(operation.message.id)) return
        const item: QueuedTurnItem = {
          message: operation.message,
          agentOverride: operation.agentOverride,
          runSpec: operation.runSpec,
          interactive: operation.interactive,
        }
        yield* reserveAndStart(handle, item, { queueOnly: false })
      })

    const submitTurn = Effect.fn("AgentLoopActor.submitTurn")(function* (
      operation: TurnSubmissionInput,
    ) {
      const handle = yield* ensureStarted
      yield* admitTurn(handle, operation)
    })

    const submitTurnAndWait = Effect.fn("AgentLoopActor.submitTurnAndWait")(function* (
      operation: TurnSubmissionInput,
    ) {
      const handle = yield* ensureStarted
      const baseline = yield* turnFailureBaseline(handle)
      yield* admitTurn(handle, operation)
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

      switch (command._tag) {
        case "Cancel":
        case "Interrupt":
          if (isActiveLoopState(yield* handle.snapshot)) {
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
            wake: command.wake,
          }
          // Steering joins the running turn at its next step boundary; the open
          // stream is not interrupted.
          //
          // An idle branch has no turn to join, so the item waits in the queue
          // where `queue.get` can still show it. Only a caller that asked to
          // wake gets a turn of its own — the same signal recovery uses at
          // startup. `appendSteering` answers with the state the queue had
          // *before* the append, so the idle test is made on that. The start
          // belongs here, inside the actor: a caller that read the state first
          // and steered second would race a turn that ended in between.
          // `startTurn` re-reads the state under its own permit, so it is a
          // no-op when a turn did begin meanwhile.
          const before = yield* handle.appendSteering(item)
          if (command.wake !== true || before._tag !== "Idle") return
          const next = yield* handle.takeNextQueuedTurnIfIdle
          if (Option.isNone(next)) return
          yield* handle.startTurn(next.value).pipe(orCleanup(handle))
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
              keyed: true,
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
            if ((yield* handle.snapshot)._tag === "WaitingForInteraction") {
              return yield* handle.respondInteraction(operation.requestId).pipe(orCleanup(handle))
            }
            // A reply to a loop that lost its turn (a restart mid-interaction)
            // resumes that turn instead; the interaction is answered inside it.
            if ((yield* handle.snapshot)._tag !== "Idle") return
            const message = yield* handle.incompleteUserTurn
            if (Option.isNone(message)) return
            const baseline = yield* turnFailureBaseline(handle)
            yield* handle.startTurn({ message: message.value }).pipe(orCleanup(handle))
            yield* awaitTurnCompletion(handle, baseline, message.value.id)
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
            const handle = lifecycleHandle(yield* Ref.get(lifecycleRef))
            if (Option.isSome(handle)) {
              yield* closeBehavior(handle.value)
            }
          }).pipe(provideActorWorkspace),
      ),
    })
  })

export { AgentLoop } from "./agent-loop.protocol.js"

export const AgentLoopLiveActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  // The replay store is built at the server actor-layer scope. Agent-loop
  // behaviors can be rebuilt for one entity, but their live tool identities
  // must remain available until the owning server scope closes.
  Layer.unwrap(
    Actor.provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toLayer(AgentLoop, build, {
          // Long-lived turn execution is owned by AgentLoopBehavior's worker queue.
          // `concurrency: "unbounded"` keeps short ops (RecordToolResult,
          // RespondInteraction, Steer) from waiting on unrelated mailbox handlers.
          concurrency: "unbounded",
        }),
      ),
    ),
  ).pipe(Layer.provide(ProcessLocalToolReplay.Live))

export const AgentLoopTestActor = (config: {
  readonly baseSections: ReadonlyArray<PromptSection>
}) =>
  Layer.unwrap(
    Actor.provideLayerBuildContext(buildAgentLoopActorHandlers(config)).pipe(
      Effect.map((build) =>
        Actor.toTestLayer(AgentLoop, build, {
          // Match the production mailbox behavior used by AgentLoopLiveActor.
          concurrency: "unbounded",
        }).pipe(Layer.provide(ShardingConfig.layerDefaults)),
      ),
    ),
  ).pipe(Layer.provide(ProcessLocalToolReplay.Live))
