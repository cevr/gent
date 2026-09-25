import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
  TxQueue,
  TxRef,
  TxSubscriptionRef,
} from "effect"
import {
  ActorCommandId,
  type BranchId,
  ClientRequestGrant,
  type InteractionRequestId,
  MessageId,
  RpcId,
  type SessionId,
} from "../domain/ids.js"
import type { AgentName } from "../domain/agent.js"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  emptyLoopQueueState,
  FollowUpQueueEntryInfo,
  isRuntimeUserMessage,
  type LoopQueueState,
  Message,
  type MessageMetadata,
  messagePartsTextLines,
  type QueuedTurnItem,
  type QueueEntryInfo,
  QueueSnapshot,
  SteeringQueueEntryInfo,
} from "../domain/message.js"
import {
  AgentLoopQueueStorage,
  EventStorage,
  type EventStorageError,
  type InteractionStorage,
  MessageStorage,
  SessionOperationStorage,
  type SessionStorage,
  ToolCallBindingStorage,
  TurnRecordStorage,
} from "../storage/storage.js"
import {
  AgentLoop,
  type AgentLoopClientServices,
  AgentLoopError,
  asAgentLoopError,
  type BranchCommandInput,
  buildIdleState,
  buildRunningState,
  followUpMessageIdForSource,
  interjectionMessageId,
  FollowUpQueueFull,
  type HandlerRequest,
  type LoopState,
  type MessageType,
  parseEntityId,
  type QueueFollowUpInput,
  dequeueFollowUpOn,
  queueFollowUpOn,
  type RemoveFollowUpInput,
  type StopMessageInput,
  type StopRequester,
  stopRequesterKey,
  stopMessageOn,
  type RequestExtensionInput,
  type RespondInteractionInput,
  type RunningState,
  type SessionRuntimeState,
  SessionRuntimeStateSchema,
  type SteerCommandType,
  type SteerInput,
  steerLoop,
  submitUserMessage,
  toWaitingForInteractionState,
  type TurnSubmissionInput,
  type WaitingForInteractionState,
} from "../domain/agent-loop.js"
import { type AgentEvent, ErrorOccurred, EventStore } from "../domain/event.js"
import type { FailedExtension } from "../domain/extension.js"
import { causeChainMessage } from "../domain/guards.js"
import {
  type ActiveStreamHandle,
  type AgentLoopTurnProfile,
  makeAgentLoopTurnExecution,
  makeTurnLedger,
  runAgentLoopTurnProfile,
  sessionAgentName,
  signalActiveStreamInterrupt,
  type TurnOutcome,
} from "./turn.js"
import {
  BranchToolWork,
  CurrentBranchToolFeature,
  makeTurnInterruption,
  ProcessLocalToolReplay,
  ToolRunner,
  type TurnInterruption,
} from "./tools.js"
import { withWideEvent } from "effect-wide-event"
import { Entity, Sharding, ShardingConfig } from "effect/unstable/cluster"
import type { SqlClient } from "effect/unstable/sql"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  ApprovalService,
  buildScopeResources,
  type CurrentExtensionHostContext,
  ExtensionRegistry,
  type ExtensionRegistryService,
  makeExtensionHostContextProvider,
  makeExtensionHostPlatform,
  resolveTurnProfile as resolveSessionTurnProfile,
  RunOpener,
  SessionProfileCache,
  type SessionProfileCacheService,
  sessionWorkingDirectory,
  suspendExtensions,
} from "./extension-host.js"
import type { ConfigService, RuntimeEnvironment } from "./config.js"
import type {
  CapabilityError,
  CapabilityNotFoundError,
  PromptSection,
} from "../domain/capability.js"
import type { StorageError } from "../domain/errors.js"
import { type ModelRegistry, ModelResolver } from "./provider.js"
import { GentPlatform } from "./gent-platform.js"
import { Actor } from "effect-encore"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

// ── agent-loop.session-governance ───────────────────────────────────────────

/**
 * Cross-(workspaceId, sessionId, branchId) session lifecycle governance for AgentLoop.
 *
 * `terminateSession(sessionId)` marks all branches of a session as
 * terminated, blocking new operations from spawning a fresh loop
 * instance. `clearTerminated(workspaceId, sessionId)` clears the marker.
 *
 * Encore actor handlers run per (entityType, entityId) where entityId
 * is `(sessionId, branchId)`. This governance lives ABOVE the per-
 * entity scope so every entity instance for the session reads the same
 * terminated set.
 *
 * @module
 */

interface AgentLoopSessionGovernanceService {
  readonly markTerminated: (workspaceId: string, sessionId: SessionId) => Effect.Effect<void>
  readonly clearTerminated: (workspaceId: string, sessionId: SessionId) => Effect.Effect<void>
  readonly isTerminated: (workspaceId: string, sessionId: SessionId) => Effect.Effect<boolean>
}

export class AgentLoopSessionGovernance extends Context.Service<
  AgentLoopSessionGovernance,
  AgentLoopSessionGovernanceService
>()("@gent/core/src/runtime/agent-loop/AgentLoopSessionGovernance") {
  static Live: Layer.Layer<AgentLoopSessionGovernance> = Layer.effect(
    AgentLoopSessionGovernance,
    Effect.gen(function* () {
      const ref = yield* TxRef.make(HashMap.empty<string, HashSet.HashSet<SessionId>>())
      return AgentLoopSessionGovernance.of({
        markTerminated: (workspaceId, sessionId) =>
          TxRef.update(ref, (m) => {
            const sessions = HashMap.get(m, workspaceId).pipe((opt) => {
              if (opt._tag === "Some") {
                return opt.value
              }
              return HashSet.empty<SessionId>()
            })
            return HashMap.set(m, workspaceId, HashSet.add(sessions, sessionId))
          }),
        clearTerminated: (workspaceId, sessionId) =>
          TxRef.update(ref, (m) => {
            const opt = HashMap.get(m, workspaceId)
            if (opt._tag === "None" || !HashSet.has(opt.value, sessionId)) return m
            const nextSessions = HashSet.remove(opt.value, sessionId)
            if (HashSet.size(nextSessions) === 0) {
              return HashMap.remove(m, workspaceId)
            }
            return HashMap.set(m, workspaceId, nextSessions)
          }),
        isTerminated: (workspaceId, sessionId) =>
          TxRef.get(ref).pipe(
            Effect.map((m) => {
              const opt = HashMap.get(m, workspaceId)
              return opt._tag === "Some" && HashSet.has(opt.value, sessionId)
            }),
          ),
      })
    }),
  )
}

// ── loop-inbox ──────────────────────────────────────────────────────────────

/**
 * The loop's inbox: everything a branch does with input it has accepted but
 * not yet answered.
 *
 * One module owns admission, follow-up order, steering, the durable
 * checkpoint, the wake decision, and the question "does this loop still hold
 * that message". No other module reads the queue representation —
 * `steering`, `followUp`, `inFlight`.
 *
 * ## The interface
 *
 * Every verb answers a question or commits a decision. None of them hands out
 * queue representation, so no caller can grow a second opinion about what
 * "queued" means.
 *
 * | Verb                    | What it hides                                                        |
 * | ----------------------- | -------------------------------------------------------------------- |
 * | `admit`                 | Batching, the depth ceiling, the idle test, the start reservation     |
 * | `take` / `takeIfIdle`   | Steering-before-follow-up order, the in-flight slot, re-stamping      |
 * | `settle`                | Which message the in-flight slot named, and whether a row changed     |
 * | `steer`                 | Where a steering item goes, and the phase a caller must test to wake  |
 * | `deliverSteering`       | What a step may take, and the final-step hold                         |
 * | `withdraw`              | That only a queued follow-up goes; an in-flight item is a turn        |
 * | `withdrawSteering`      | That a joined or taken steering item stays; only a waiting one goes   |
 * | `drain`                 | That the in-flight item survives a drain; the snapshot the TUI reads  |
 * | `holds`                 | The five places one message can sit                                   |
 * | `moveToPhase`           | That a phase move is a memory write, and spends the reservation       |
 * | `writeInitialQueue`     | That a fresh branch has no row until its first open                   |
 *
 * `read`, `changes`, `runtimeState`, `runtimeChanges`, `snapshot` and `phase`
 * are reads of the same Ref, kept here because the runtime projection derives
 * from the queue and must not lag it.
 *
 * `take` and `takeIfIdle` stay separate on purpose. The worker owns the turn
 * lane and takes unconditionally; the actor races other admissions and must
 * not take past a reservation. Folding them into one option would make every
 * caller state the guard the module exists to hold.
 *
 * ## Depth
 *
 * The persisted shape lives in `domain/message.ts` with the snapshot it projects
 * to, because storage decodes it. This module is the only code that reads or
 * writes its three compartments — every other file sees verbs.
 *
 * `wantsWakeOnRecovery` is the one exported function over a
 * loaded-but-not-yet-installed queue: startup has to decide whether to wake
 * before a loop exists to ask.
 *
 * @module
 */

/**
 * Should a loop rebuilt over this stored queue take a turn straight away?
 *
 * Startup has a queue and no loop yet, so it cannot ask the inbox. A recovered
 * queue with nothing in it never wakes; one holding an explicit wake request
 * always does. Everything else defers to whether the branch has history.
 */
export const wantsWakeOnRecovery = (
  queue: LoopQueueState,
): Option.Option<{ readonly unconditional: boolean }> => {
  const hasItems =
    Predicate.isNotUndefined(queue.inFlight) ||
    queue.steering.length > 0 ||
    queue.followUp.length > 0
  if (!hasItems) return Option.none()
  const unconditional =
    queue.followUp.some((item) => item.wake === true) ||
    queue.steering.some((item) => item.wake === true) ||
    queue.inFlight?.wake === true
  return Option.some({ unconditional })
}

// ── Pure algebra (module-private) ──
//
// No caller outside this file sees these. They are the only code that knows
// the queue has three compartments.

const FOLLOW_UP_QUEUE_MAX = 10

/**
 * Each follow-up stays its own item with its own id, parts, and turn. A
 * repeat of a queued id replaces that item in place, so a retry neither
 * duplicates nor drops content.
 */
const appendFollowUpItem = (
  queue: ReadonlyArray<QueuedTurnItem>,
  item: QueuedTurnItem,
): QueuedTurnItem[] => {
  const existingIndex = queue.findIndex((queued) => queued.message.id === item.message.id)
  if (existingIndex < 0) return [...queue, item]
  return queue.with(existingIndex, item)
}

const toQueueEntry = (
  tag: "Steering" | "FollowUp",
  item: QueuedTurnItem,
): Option.Option<QueueEntryInfo> => {
  const content = messagePartsTextLines(item.message.parts).join("\n")
  if (content === "") return Option.none()
  const fields = {
    id: item.message.id,
    content,
    createdAt: item.message.createdAt.getTime(),
  }
  if (tag === "Steering") {
    return Option.some(SteeringQueueEntryInfo.make(fields))
  }
  return Option.some(FollowUpQueueEntryInfo.make(fields))
}

const toQueueSnapshot = (
  steeringItems: ReadonlyArray<QueuedTurnItem>,
  followUpItems: ReadonlyArray<QueuedTurnItem>,
): QueueSnapshot =>
  new QueueSnapshot({
    steering: steeringItems.flatMap((item) =>
      Option.match(toQueueEntry("Steering", item), {
        onNone: () => [],
        onSome: (entry) => [entry],
      }),
    ),
    followUp: followUpItems.flatMap((item) =>
      Option.match(toQueueEntry("FollowUp", item), {
        onNone: () => [],
        onSome: (entry) => [entry],
      }),
    ),
  })

const drainVisibleQueueItems = (queue: LoopQueueState): LoopQueueState => ({
  steering: [],
  followUp: [],
  inFlight: queue.inFlight,
})

/** Drops one queued follow-up. An in-flight item is already a turn and stays. */
const removeQueuedFollowUp = (queue: LoopQueueState, messageId: MessageId): LoopQueueState => {
  const followUp = queue.followUp.filter((item) => item.message.id !== messageId)
  if (followUp.length === queue.followUp.length) return queue
  return { ...queue, followUp }
}

const appendSteeringItem = (queue: LoopQueueState, item: QueuedTurnItem): LoopQueueState => {
  const inFlight = Option.fromUndefinedOr(queue.inFlight)
  if (
    (Option.isSome(inFlight) && inFlight.value.message.id === item.message.id) ||
    queue.steering.some((existing) => existing.message.id === item.message.id)
  ) {
    return queue
  }
  return {
    ...queue,
    steering: [...queue.steering, item],
  }
}

const appendFollowUpQueueState = (queue: LoopQueueState, item: QueuedTurnItem): LoopQueueState => {
  const inFlight = Option.fromUndefinedOr(queue.inFlight)
  if (Option.isSome(inFlight) && inFlight.value.message.id === item.message.id) return queue
  return {
    ...queue,
    followUp: appendFollowUpItem(queue.followUp, item),
  }
}

const restampQueuedMessage = (message: Message, createdAt: Date): Message => {
  const fields = {
    id: message.id,
    sessionId: message.sessionId,
    branchId: message.branchId,
    role: message.role,
    parts: message.parts,
    createdAt,
    turnDurationMs: message.turnDurationMs,
    metadata: message.metadata,
  }
  if (message._tag === "interjection") {
    return Message.cases.interjection.make({ ...fields, role: "user" })
  }
  return Message.cases.regular.make(fields)
}

const restampQueuedTurnItem = (item: QueuedTurnItem, createdAt: Date): QueuedTurnItem => ({
  ...item,
  message: restampQueuedMessage(item.message, createdAt),
})

interface QueuedTurnTake {
  readonly queue: LoopQueueState
  readonly nextItem: Option.Option<QueuedTurnItem>
}

const takeNextQueuedTurn = (queue: LoopQueueState, createdAt: Date): QueuedTurnTake => {
  if (!Predicate.isUndefined(queue.inFlight)) {
    return { queue, nextItem: Option.some(queue.inFlight) } satisfies QueuedTurnTake
  }

  const [nextSteer, ...restSteering] = queue.steering
  if (!Predicate.isUndefined(nextSteer)) {
    const nextItem = restampQueuedTurnItem(nextSteer, createdAt)
    return {
      queue: { ...queue, steering: restSteering, inFlight: nextItem },
      nextItem: Option.some(nextItem),
    } satisfies QueuedTurnTake
  }

  const [nextFollowUp, ...restFollowUp] = queue.followUp
  if (Predicate.isUndefined(nextFollowUp)) {
    return { queue, nextItem: Option.none() } satisfies QueuedTurnTake
  }

  const nextItem = restampQueuedTurnItem(nextFollowUp, createdAt)
  return {
    queue: { ...queue, followUp: restFollowUp, inFlight: nextItem },
    nextItem: Option.some(nextItem),
  } satisfies QueuedTurnTake
}

const clearInFlightQueuedTurn = (queue: LoopQueueState, messageId: MessageId): LoopQueueState => {
  const inFlight = Option.fromUndefinedOr(queue.inFlight)
  if (Option.isSome(inFlight) && inFlight.value.message.id === messageId) {
    return {
      steering: queue.steering,
      followUp: queue.followUp,
    }
  }
  return queue
}

/** The phase runs, or waits on an interaction in, the turn this message opened. */
const phaseHolds = (phase: LoopState, messageId: MessageId): boolean => {
  if (phase._tag === "Idle") return false
  return phase.message.id === messageId
}

/** The loop still owns this message: starting, running, waiting, or queued. */
const loopHoldsMessage = (s: AgentLoopState, messageId: MessageId): boolean => {
  const item = (queued: QueuedTurnItem) => queued.message.id === messageId
  return (
    phaseHolds(s.state, messageId) ||
    (Predicate.isNotUndefined(s.startingState) && phaseHolds(s.startingState, messageId)) ||
    (Predicate.isNotUndefined(s.queue.inFlight) && item(s.queue.inFlight)) ||
    s.queue.followUp.some(item) ||
    s.queue.steering.some(item)
  )
}

const queueSnapshotFromQueueState = (queue: LoopQueueState): QueueSnapshot =>
  toQueueSnapshot(queue.steering, queue.followUp)

// ── Aggregate (single-Ref shape) ──
//
// The per-branch memory the loop reads and writes through one
// SubscriptionRef. It lives here because every field but `state` is the
// inbox's: the queue, the start reservation the inbox hands out, and the
// failure epoch it merges across concurrent transactions. `runtimeState`
// derives from `state` + `queue` at the watchState boundary and is never
// stored, so the projection cannot lag.

export interface AgentLoopState {
  readonly state: LoopState
  readonly queue: LoopQueueState
  readonly turnFailure?: {
    readonly epoch: number
    /** The message whose turn failed; only that message's caller fails. */
    readonly messageId: MessageId
    readonly error: unknown
  }
  readonly startingState?: LoopState
}

export const buildInitialAgentLoopState = (params: {
  state: LoopState
  queue?: LoopQueueState
}): AgentLoopState => ({
  state: params.state,
  queue: Option.getOrElse(Option.fromUndefinedOr(params.queue), emptyLoopQueueState),
})

/**
 * Tag for tag with `LoopState`, derived from the same `AgentLoopState` on
 * every read. The projection cannot lag the machine, so a caller that wants
 * the current phase reads either one, never both.
 */
const projectRuntimeState = (s: AgentLoopState): SessionRuntimeState => {
  // The agent is the session's, not the loop's: the snapshot names it.
  const queue = queueSnapshotFromQueueState(s.queue)

  return Match.type<LoopState>().pipe(
    Match.tagsExhaustive({
      Idle: () => SessionRuntimeStateSchema.cases.Idle.make({ queue }),
      Running: ({ startedAtMs }) =>
        SessionRuntimeStateSchema.cases.Running.make({ queue, startedAtMs }),
      WaitingForInteraction: ({ startedAtMs }) =>
        SessionRuntimeStateSchema.cases.WaitingForInteraction.make({ queue, startedAtMs }),
    }),
  )(s.state)
}

/**
 * The loop already holds this message's turn: reserved, running, parked on
 * an interaction, or in flight. A running turn gave up its in-flight slot
 * when it started, so the phase is what names it then.
 */
const turnAdmitted = (s: AgentLoopState, messageId: MessageId): boolean =>
  s.queue.inFlight?.message.id === messageId ||
  phaseHolds(s.state, messageId) ||
  (Predicate.isNotUndefined(s.startingState) && phaseHolds(s.startingState, messageId))

/**
 * Whether a caller may take a turn for this branch right now.
 *
 * Idle is not enough on its own. `startingState` holds an item another caller
 * already reserved but whose start has not run yet: it has left the queue and
 * has not reached `state`, so a plain idle test cannot see it. A caller that
 * takes a turn past that reservation leaves the reserved start, which the loop
 * already forked (`startInLoop`), to move a phase another turn holds, with its
 * item in neither the queue nor the transcript. Both admission paths ask this
 * one question.
 */

export const canStartTurnNow = (s: AgentLoopState): boolean =>
  s.state._tag === "Idle" && Predicate.isUndefined(s.startingState)

/** How many failures this branch had recorded, or 0 if it has had none. */
const turnFailureEpoch = (state: AgentLoopState): number =>
  Option.getOrElse(
    Option.fromUndefinedOr(state.turnFailure).pipe(Option.map(({ epoch }) => epoch)),
    () => 0,
  )

// ── The module ──

/**
 * The queue writes that failed so far, as a monotonic counter with the latest
 * error. A waiter records the epoch before it starts and fails only on a mark
 * past it, so a write that failed once never fails a later caller.
 */
interface PersistenceFailureMark {
  readonly epoch: number
  readonly error: Option.Option<AgentLoopError>
}

type LoopInboxContext = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly loopRef: TxSubscriptionRef.TxSubscriptionRef<AgentLoopState>
  readonly queuePersistenceSemaphore: Semaphore.Semaphore
  readonly persistenceFailures: TxSubscriptionRef.TxSubscriptionRef<PersistenceFailureMark>
  readonly startedRef: Ref.Ref<boolean>
  /** Whether this message's turn already has its receipt (a stored duration). */
  readonly turnSettled: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  /** Whether this message is stored: a steering item joined a turn or ran as one. */
  readonly messageStored: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
}

export type LoopInbox = {
  // Reads of the one Ref. The runtime projection derives from the queue on
  // every read, so it cannot lag the machine.
  readonly read: Effect.Effect<AgentLoopState>
  readonly changes: Stream.Stream<AgentLoopState>
  readonly runtimeState: Effect.Effect<SessionRuntimeState>
  readonly runtimeChanges: Stream.Stream<SessionRuntimeState>
  readonly snapshot: Effect.Effect<QueueSnapshot>
  readonly phase: Effect.Effect<LoopState>
  /**
   * Write the branch its queue row once the loop is started.
   *
   * A branch that has never queued anything has no row, and every later write
   * is a conditional update inside a queue transaction. This is the one
   * unconditional write, so a fresh branch has a row from its first open on.
   */
  readonly writeInitialQueue: Effect.Effect<void, AgentLoopError>
  /**
   * Accept one item. `Some` means the caller reserved the start and must run
   * the turn; `None` means the item is queued and something else will take it,
   * or that its turn is already admitted, running or settled: a replay is not
   * a new turn. The settled read and the admission hold one queue permit, and
   * a turn stores its receipt before it leaves the phase, so no turn settles
   * between them.
   */
  readonly admit: (
    item: QueuedTurnItem,
    options: { readonly queueOnly: boolean },
  ) => Effect.Effect<Option.Option<RunningState>, AgentLoopError | FollowUpQueueFull>
  /**
   * Take the next item only while nothing else holds or has reserved the loop.
   * `Some` also reserves the start for that item, as `admit` does.
   */
  readonly takeIfIdle: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  /** Take the next item; the caller already owns the turn lane. */
  readonly take: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  /** True when this message was the in-flight admission and is now settled. */
  readonly settle: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  /**
   * Queue one steering item and answer with the phase the loop was in *before*
   * the append, which is what a caller must test to decide on a wake. Reading
   * the phase separately would race a turn that ended in between. None: the
   * item was already delivered (a repeat of its request id), and nothing changed.
   */
  readonly steer: (item: QueuedTurnItem) => Effect.Effect<Option.Option<LoopState>, AgentLoopError>
  /**
   * Hand a running step the steering it may take, and forget it once the
   * caller's `join` has written it to the transcript.
   *
   * `finalStep` holds everything back: delivery takes the item off the queue,
   * and with no step left to read it the message would be gone. It stays
   * queued and opens the next turn.
   *
   * The transcript write commits before the queue write. A crash between the
   * two replays a delivery that the message write already treats as a no-op;
   * the other order loses input the branch accepted.
   */
  readonly deliverSteering: <E, R>(params: {
    readonly finalStep: boolean
    readonly join: (item: QueuedTurnItem) => Effect.Effect<void, E, R>
  }) => Effect.Effect<boolean, AgentLoopError | E, R>
  /** Clear what the TUI can see and answer with what was cleared. */
  readonly drain: Effect.Effect<QueueSnapshot, AgentLoopError>
  /** True when a queued follow-up was removed; false when absent or already in flight. */
  readonly withdraw: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  /**
   * Take back a steering item that still waits; true when one was taken. One a
   * step already joined is in the transcript, and one a turn took is that
   * turn; both stay. A step's join and a take-back hold the same permit, so
   * each sees what the other decided.
   */
  readonly withdrawSteering: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  /** Does the loop still own this message, anywhere? */
  readonly holds: (state: AgentLoopState, messageId: MessageId) => boolean
  readonly moveToPhase: (next: LoopState) => Effect.Effect<void>
}

const mergeConcurrentLoopMetadata = (
  base: AgentLoopState,
  current: AgentLoopState,
  next: AgentLoopState,
): AgentLoopState => {
  if (current.turnFailure === base.turnFailure) return next
  const merged = { ...next }
  if (Predicate.isUndefined(current.turnFailure)) {
    delete merged.turnFailure
  } else {
    merged.turnFailure = current.turnFailure
  }
  return merged
}

export const makeLoopInbox = (
  scope: LoopInboxContext,
): Effect.Effect<LoopInbox, never, AgentLoopQueueStorage> =>
  Effect.gen(function* () {
    const queueStorage = yield* AgentLoopQueueStorage

    const persistCommittedQueue = (queue: LoopQueueState, operation: string) =>
      Effect.flatMap(Ref.get(scope.startedRef), (started) => {
        if (!started) return Effect.void
        return queueStorage
          .putQueueState(scope.sessionId, scope.branchId, queue)
          .pipe(
            asAgentLoopError(
              `Failed to persist ${operation} for ${scope.sessionId}/${scope.branchId}`,
            ),
          )
      })

    const recordPersistenceFailure = (error: AgentLoopError) =>
      TxSubscriptionRef.update(scope.persistenceFailures, (mark) => ({
        epoch: mark.epoch + 1,
        error: Option.some(error),
      }))

    /** A queue transaction; the caller holds the queue permit. */
    const commitQueueTransactionHeld = <A>(
      operation: string,
      decide: (state: AgentLoopState) => {
        readonly value: A
        readonly next: AgentLoopState
        readonly persist: boolean
      },
    ): Effect.Effect<A, AgentLoopError> =>
      Effect.gen(function* () {
        const base = yield* TxSubscriptionRef.get(scope.loopRef)
        const decision = decide(base)
        if (decision.persist) {
          yield* persistCommittedQueue(decision.next.queue, operation).pipe(
            Effect.tapError(recordPersistenceFailure),
          )
        }
        yield* TxSubscriptionRef.update(scope.loopRef, (current) =>
          mergeConcurrentLoopMetadata(base, current, decision.next),
        )
        return decision.value
      })

    const commitQueueTransaction = <A>(
      operation: string,
      decide: Parameters<typeof commitQueueTransactionHeld<A>>[1],
    ): Effect.Effect<A, AgentLoopError> =>
      commitQueueTransactionHeld(operation, decide).pipe(
        scope.queuePersistenceSemaphore.withPermits(1),
      )

    /**
     * Move the loop to its next phase.
     *
     * Storage holds the queue and nothing else, and a phase move never changes
     * the queue: every caller has already run its `commitQueueTransaction`,
     * which wrote the row when — and only when — the queue actually changed.
     * So this is a memory write. Dropping `startingState` is the point: the
     * reservation this phase consumed is spent, and it was never durable.
     */
    const moveToPhase = (state: LoopState): Effect.Effect<void> =>
      TxSubscriptionRef.update(scope.loopRef, (current) => {
        const next: AgentLoopState = { state, queue: current.queue }
        if (!Predicate.isUndefined(current.turnFailure)) {
          return Object.assign(next, { turnFailure: current.turnFailure })
        }
        return next
      }).pipe(scope.queuePersistenceSemaphore.withPermits(1))

    const read = TxSubscriptionRef.get(scope.loopRef)
    const phase = read.pipe(Effect.map((s) => s.state))
    const changes = TxSubscriptionRef.changesStream(scope.loopRef)
    const runtimeState: Effect.Effect<SessionRuntimeState> = read.pipe(
      Effect.map(projectRuntimeState),
    )
    const runtimeChanges = changes.pipe(Stream.map(projectRuntimeState))
    const snapshot: Effect.Effect<QueueSnapshot> = read.pipe(
      Effect.map((s) => queueSnapshotFromQueueState(s.queue)),
    )

    const admit = Effect.fn("LoopInbox.admit")(function* (
      item: QueuedTurnItem,
      options: { readonly queueOnly: boolean },
    ) {
      const startedAtMs = yield* Clock.currentTimeMillis
      if (yield* scope.turnSettled(item.message.id)) return Option.none<RunningState>()
      const decided = yield* commitQueueTransactionHeld<
        Option.Option<RunningState> | FollowUpQueueFull
      >("reserved or queued follow-up", (current) => {
        if (turnAdmitted(current, item.message.id)) {
          return { value: Option.none(), next: current, persist: false }
        }
        // Build the next queue first: a retry of a queued id replaces in
        // place, so only an admission that grows the queue past the cap fails.
        const nextQueue = appendFollowUpQueueState(current.queue, item)
        if (
          nextQueue.followUp.length > current.queue.followUp.length &&
          nextQueue.followUp.length > FOLLOW_UP_QUEUE_MAX
        ) {
          return {
            value: new FollowUpQueueFull({ max: FOLLOW_UP_QUEUE_MAX }),
            next: current,
            persist: false,
          }
        }

        if (options.queueOnly) {
          return {
            value: Option.none(),
            next: { ...current, queue: nextQueue },
            persist: true,
          }
        }

        if (!canStartTurnNow(current)) {
          return {
            value: Option.none(),
            next: { ...current, queue: nextQueue },
            persist: true,
          }
        }

        const reservedRunningState = buildRunningState(item, { startedAtMs })
        return {
          value: Option.some(reservedRunningState),
          next: { ...current, startingState: reservedRunningState },
          persist: false,
        }
      })
      if (Schema.is(FollowUpQueueFull)(decided)) return yield* decided
      return decided
    }, scope.queuePersistenceSemaphore.withPermits(1))

    const writeInitialQueue = Effect.suspend(
      Effect.fn("LoopInbox.writeInitialQueue")(function* () {
        if (!(yield* Ref.get(scope.startedRef))) return
        const current = yield* TxSubscriptionRef.get(scope.loopRef)
        yield* persistCommittedQueue(current.queue, "initial queue").pipe(
          Effect.tapError(recordPersistenceFailure),
          scope.queuePersistenceSemaphore.withPermits(1),
        )
      }),
    )

    const takeFromState = Effect.fn("LoopInbox.take")(function* (options: {
      readonly onlyIfIdle: boolean
    }) {
      const queuedCreatedAt = yield* DateTime.nowAsDate
      const startedAtMs = yield* Clock.currentTimeMillis
      return yield* commitQueueTransaction("dequeued turn", (s) => {
        if (options.onlyIfIdle && !canStartTurnNow(s)) {
          return { value: Option.none(), next: s, persist: false }
        }
        const { queue, nextItem } = takeNextQueuedTurn(s.queue, queuedCreatedAt)
        // An idle take races other admissions, so it reserves the start in the
        // same transaction, as `admit` does: an admission that arrives before
        // the caller starts the turn queues behind it.
        if (options.onlyIfIdle && Option.isSome(nextItem)) {
          return {
            value: nextItem,
            next: {
              ...s,
              queue,
              startingState: buildRunningState(nextItem.value, { startedAtMs }),
            },
            persist: queue !== s.queue,
          }
        }
        return {
          value: nextItem,
          next: { ...s, queue },
          persist: queue !== s.queue,
        }
      })
    })

    // A removal answers whether it took anything, and stores only when it did.
    // `remove` returns the same queue when nothing matched.
    const removeFromQueue = (label: string, remove: (queue: LoopQueueState) => LoopQueueState) =>
      commitQueueTransaction(label, (s) => {
        const queue = remove(s.queue)
        const removed = queue !== s.queue
        return { value: removed, next: { ...s, queue }, persist: removed }
      })

    const settle = Effect.fn("LoopInbox.settle")((messageId: MessageId) =>
      removeFromQueue("cleared in-flight turn", (queue) =>
        clearInFlightQueuedTurn(queue, messageId),
      ),
    )

    // Delivery stores the message before it drops the item, and the drop takes
    // this permit, so under it an item is either still queued or stored.
    const steer = Effect.fn("LoopInbox.steer")(function* (item: QueuedTurnItem) {
      if (yield* scope.messageStored(item.message.id)) return Option.none<LoopState>()
      return yield* commitQueueTransactionHeld("queued steering", (s) => ({
        value: Option.some(s.state),
        next: { ...s, queue: appendSteeringItem(s.queue, item) },
        persist: true,
      }))
    }, scope.queuePersistenceSemaphore.withPermits(1))

    // A queued copy goes even when the message is stored: a turn that id
    // opened may run while a repeat of its steer still waits.
    const withdrawSteering = (messageId: MessageId) =>
      removeFromQueue("withdrew steering", (queue) => {
        const kept = queue.steering.filter((item) => item.message.id !== messageId)
        if (kept.length === queue.steering.length) return queue
        return { ...queue, steering: kept }
      }).pipe(Effect.withSpan("LoopInbox.withdrawSteering"))

    const dropSteeringDelivered = (delivered: ReadonlyArray<QueuedTurnItem>) => {
      if (delivered.length === 0) return Effect.void
      const deliveredIds = new Set<string>(delivered.map((item) => item.message.id))
      return commitQueueTransactionHeld("dropped delivered steering", (s) => {
        const kept = s.queue.steering.filter((item) => !deliveredIds.has(item.message.id))
        if (kept.length === s.queue.steering.length) {
          return { value: void 0, next: s, persist: false }
        }
        return {
          value: void 0,
          next: { ...s, queue: { ...s.queue, steering: kept } },
          persist: true,
        }
      })
    }

    // The read, the joins and the drop hold the queue permit as one decision:
    // a take-back (`withdrawSteering`) waits for it, then finds the item gone,
    // and a take-back that came first leaves nothing here to join.
    const joinSteering = Effect.fn("LoopInbox.deliverSteering")(function* <E, R>(
      join: (item: QueuedTurnItem) => Effect.Effect<void, E, R>,
    ) {
      const state = yield* TxSubscriptionRef.get(scope.loopRef)
      const items = state.queue.steering
      for (const item of items) {
        yield* join(item)
      }
      yield* dropSteeringDelivered(items)
      return items.length > 0
    })
    const deliverSteering = <E, R>(params: {
      readonly finalStep: boolean
      readonly join: (item: QueuedTurnItem) => Effect.Effect<void, E, R>
    }): Effect.Effect<boolean, AgentLoopError | E, R> => {
      if (params.finalStep) return Effect.succeed(false)
      return joinSteering(params.join).pipe(scope.queuePersistenceSemaphore.withPermits(1))
    }

    const drain = commitQueueTransaction("drained queue", (s) => ({
      value: queueSnapshotFromQueueState(s.queue),
      next: { ...s, queue: drainVisibleQueueItems(s.queue) },
      persist: true,
    })).pipe(Effect.withSpan("LoopInbox.drain"))

    const withdraw = Effect.fn("LoopInbox.withdraw")((messageId: MessageId) =>
      removeFromQueue("removed queued follow-up", (queue) =>
        removeQueuedFollowUp(queue, messageId),
      ),
    )

    return {
      read,
      changes,
      runtimeState,
      runtimeChanges,
      snapshot,
      phase,
      writeInitialQueue,
      admit,
      takeIfIdle: takeFromState({ onlyIfIdle: true }),
      take: takeFromState({ onlyIfIdle: false }),
      settle,
      steer,
      deliverSteering,
      drain,
      withdraw,
      withdrawSteering,
      holds: loopHoldsMessage,
      moveToPhase,
    } satisfies LoopInbox
  })

// ── worker ──────────────────────────────────────────────────────────────────

type AgentLoopWorkerContext<E = never, R = never> = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sideMutationSemaphore: Semaphore.Semaphore
  readonly interruptSemaphore: Semaphore.Semaphore
  readonly turnWorkerQueue: TxQueue.TxQueue<RunningState>
  readonly activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>
  readonly turnInterruption: TurnInterruption
  /** Cancel whatever tool work this loop has in flight. Idempotent. */
  readonly interruptToolWork: Effect.Effect<void>
  readonly inbox: LoopInbox
  readonly admissionGateRef: Ref.Ref<AdmissionGate>
  readonly recordTurnFailure: (
    cause: Cause.Cause<unknown>,
    messageId: MessageId,
  ) => Effect.Effect<void>
  readonly publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  /** Append the receipt of a turn a phase failure stopped and run its hooks; never fails. */
  readonly completeFailedTurn: (state: RunningState) => Effect.Effect<void>
  readonly runTurn: (state: RunningState) => Effect.Effect<TurnOutcome, AgentLoopError | E, R>
  /** The agent the session runs as; it names the actor of each turn's wide event. */
  readonly sessionAgent: Effect.Effect<AgentName, AgentLoopError | E, R>
  /** True when this request already has an answer waiting for its owner. */
  readonly interactionAnswered: (requestId: InteractionRequestId) => Effect.Effect<boolean>
  /** The loop's own scope: a start runs here, so no caller's interrupt reaches it. */
  readonly loopScope: Scope.Scope
}

/**
 * Settles the race between a worker starting an admitted turn and a caller
 * withdrawing it. `started` names the turn the worker claimed; `withdrawn`
 * names an admission the worker must skip. One `Ref.modify` decides each side.
 */
interface AdmissionGate {
  readonly started: Option.Option<MessageId>
  readonly withdrawn: Option.Option<MessageId>
}

export const emptyAdmissionGate: AdmissionGate = {
  started: Option.none(),
  withdrawn: Option.none(),
}

const names = (id: Option.Option<MessageId>, messageId: MessageId) =>
  Option.isSome(id) && id.value === messageId

const interruptActiveStream = Effect.fn("AgentLoop.interruptActiveStream")(function* (
  activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>,
) {
  const activeStream = yield* Ref.get(activeStreamRef)
  if (Option.isNone(activeStream)) return
  yield* signalActiveStreamInterrupt(activeStream.value)
})

export const makeAgentLoopWorker = <E, R>(scope: AgentLoopWorkerContext<E, R>) => {
  // The event is what the transcript prints, so it carries the messages down
  // the cause chain. The frames go to the log: one storage failure printed
  // 150 rows of them into a live session.
  const publishPhaseFailure = (cause: Cause.Cause<unknown>) =>
    Effect.logWarning("turn.phase-failed")
      .pipe(
        Effect.annotateLogs({ error: Cause.pretty(cause) }),
        Effect.andThen(
          scope.publishEvent(
            ErrorOccurred.make({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              error: causeChainMessage(Cause.squash(cause)),
            }),
          ),
        ),
      )
      .pipe(
        Effect.catchEager((error) =>
          Effect.logWarning("failed to publish ErrorOccurred").pipe(
            Effect.annotateLogs({ error: String(error) }),
          ),
        ),
        Effect.asVoid,
      )

  const enqueueTurnWorker = (state: RunningState): Effect.Effect<void> =>
    TxQueue.offer(scope.turnWorkerQueue, state).pipe(Effect.asVoid)

  /** Start the next admitted turn on this loop, or park it idle. */
  const advanceOrIdle = (
    nextItem: Option.Option<QueuedTurnItem>,
  ): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      if (Option.isNone(nextItem)) return yield* scope.inbox.moveToPhase(buildIdleState())
      const startedAtMs = yield* Clock.currentTimeMillis
      const nextRunning = buildRunningState(nextItem.value, { startedAtMs })
      yield* scope.inbox.moveToPhase(nextRunning)
      yield* enqueueTurnWorker(nextRunning)
    })

  /** Resume a turn parked on an interaction under its original admission. */
  const resumeWaiting = (state: WaitingForInteractionState): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      const resumed = buildRunningState(state, { startedAtMs: state.startedAtMs })
      yield* scope.inbox.moveToPhase(resumed)
      yield* enqueueTurnWorker(resumed)
    })

  const finishTurnWorker = (
    startState: RunningState,
    outcome: TurnOutcome,
  ): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      if (outcome._tag === "InteractionRequested") {
        const next = toWaitingForInteractionState({
          state: startState,
          pendingRequestId: outcome.pendingRequestId,
        })
        yield* scope.inbox.moveToPhase(next)
        // An answer that came while a sibling call still ran found no parked
        // loop to wake. It is stored, so the turn goes on at once.
        if (yield* scope.interactionAnswered(outcome.pendingRequestId)) yield* resumeWaiting(next)
        return
      }

      const nextItem = yield* scope.inbox.take
      yield* scope.turnInterruption.beginTurn
      yield* advanceOrIdle(nextItem)
    })

  /**
   * Ends a turn a phase failure stopped. The receipt and the `turnAfter`
   * hooks run outside the interrupt permit, as a normal turn's do inside
   * `runTurn`: a hook may stop its own branch, and a Cancel that arrives
   * meanwhile stops this turn, not the next one. Only the hand-over to the
   * next item takes the permit, as `finishTurnWorker` does.
   */
  const failTurnWorker = (
    startState: RunningState,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      yield* scope.recordTurnFailure(cause, startState.message.id)
      yield* publishPhaseFailure(cause)
      yield* scope.completeFailedTurn(startState)
      yield* Effect.gen(function* () {
        // A turn that failed before it settled still holds the in-flight slot,
        // and `take` hands that slot back first. Clear it, so the failed turn
        // ends here and the next queued item runs.
        yield* scope.inbox.settle(startState.message.id)
        const nextItem = yield* scope.inbox.take
        yield* scope.turnInterruption.beginTurn
        yield* advanceOrIdle(nextItem)
      }).pipe(scope.interruptSemaphore.withPermits(1))
    })

  /** Claims the admission for this worker; false when it was withdrawn before the claim. */
  const claimAdmission = (messageId: MessageId): Effect.Effect<boolean> =>
    Ref.modify(scope.admissionGateRef, (gate): [boolean, AdmissionGate] => {
      if (names(gate.withdrawn, messageId)) return [false, { ...gate, withdrawn: Option.none() }]
      return [true, { ...gate, started: Option.some(messageId) }]
    })

  const releaseAdmission = Ref.update(scope.admissionGateRef, (gate): AdmissionGate => ({
    ...gate,
    started: Option.none(),
  }))

  const runTurnWorker = (startState: RunningState) =>
    Effect.gen(function* () {
      // A withdrawn admission (see `withdrawAdmittedTurn`) leaves its entry in
      // the worker queue; the gate decides whether this entry still runs.
      if (!(yield* claimAdmission(startState.message.id))) return
      // The agent read is part of the turn: a failed read (a busy database, an
      // admission that does not decode) fails this turn and releases its
      // admission like any other failure, and the worker takes the next item.
      yield* scope.sessionAgent.pipe(
        Effect.flatMap((actor) =>
          scope.runTurn(startState).pipe(
            Effect.annotateLogs({ sessionId: scope.sessionId, branchId: scope.branchId }),
            Effect.withSpan("AgentLoop.turn"),
            withWideEvent({
              service: "agent-loop",
              method: "turn",
              actor,
              envelope: { sessionId: scope.sessionId, branchId: scope.branchId },
            }),
          ),
        ),
        Effect.matchCauseEffect({
          onFailure: (cause) => failTurnWorker(startState, cause),
          onSuccess: (outcome) =>
            finishTurnWorker(startState, outcome).pipe(scope.interruptSemaphore.withPermits(1)),
        }),
        Effect.catchCause((cause) =>
          scope
            .recordTurnFailure(cause, startState.message.id)
            .pipe(Effect.andThen(publishPhaseFailure(cause)), Effect.ignore),
        ),
        Effect.ignore,
        Effect.ensuring(releaseAdmission),
      )
    }).pipe(scope.sideMutationSemaphore.withPermits(1))

  /**
   * Drops a turn that was admitted as the next run but has not started. It
   * takes no side-mutation permit: a re-entrant caller (an extension request
   * or hook) already holds it, and the `RemoveFollowUp` handler holds none.
   * The admission gate serializes it against the worker's claim, and the
   * in-flight marker proves the turn is only queued. The next queued item (if
   * any) takes its place under the interrupt permit, as every other hand-over
   * does, so an interrupt latched for the withdrawn turn never stops it.
   */
  const withdrawAdmittedTurn = Effect.fn("AgentLoop.withdrawAdmittedTurn")((messageId: MessageId) =>
    Effect.gen(function* () {
      const state = yield* scope.inbox.phase
      if (state._tag !== "Running" || state.message.id !== messageId) return false
      // The gate is the only serialization point: a second concurrent withdrawal
      // of the same admission loses here, so it can never clear the marker that
      // keeps the worker from running the turn.
      const won = yield* Ref.modify(scope.admissionGateRef, (gate): [boolean, AdmissionGate] => {
        if (names(gate.started, messageId) || names(gate.withdrawn, messageId)) return [false, gate]
        return [true, { ...gate, withdrawn: Option.some(messageId) }]
      })
      if (!won) return false
      // A resumed interaction turn is Running without an in-flight marker: it already started.
      if (!(yield* scope.inbox.settle(messageId))) {
        yield* Ref.update(scope.admissionGateRef, (gate) => ({ ...gate, withdrawn: Option.none() }))
        return false
      }
      yield* Effect.gen(function* () {
        const nextItem = yield* scope.inbox.take
        yield* scope.turnInterruption.beginTurn
        yield* advanceOrIdle(nextItem)
      }).pipe(scope.interruptSemaphore.withPermits(1))
      return true
    }),
  )

  const turnWorkerLoop = TxQueue.take(scope.turnWorkerQueue).pipe(
    Effect.flatMap(runTurnWorker),
    Effect.forever,
    Effect.ignore,
  )

  /** The running turn's stop latch, read once; none when no turn runs. */
  const stopLatch = Effect.fn("AgentLoop.stopLatch")(function* () {
    const snap = yield* scope.inbox.phase
    if (snap._tag === "Idle") return Option.none<StopLatch>()
    return Option.some<StopLatch>({
      messageId: snap.message.id,
      stopped: yield* scope.turnInterruption.interrupted,
      by: yield* scope.turnInterruption.stoppedFor,
    })
  })

  /**
   * True when a turn (the one `messageId` names, if given) was running and is
   * now stopping. `by` names the stop's requester, recorded when this is the
   * turn's first interrupt.
   */
  const interrupt = Effect.fn("AgentLoop.interrupt")(function* (
    messageId?: MessageId,
    by?: string,
  ) {
    const reached = yield* Effect.gen(function* () {
      const snap = yield* scope.inbox.phase
      if (snap._tag === "Idle") return { latched: false, waiting: false }
      if (Predicate.isNotUndefined(messageId) && snap.message.id !== messageId) {
        return { latched: false, waiting: false }
      }
      // The latch is set before anything can resume the parked turn, so an
      // answer that wins the resume still runs a turn that stops at once.
      if (Predicate.isUndefined(by)) yield* scope.turnInterruption.interrupt
      else yield* scope.turnInterruption.interruptFor(by)
      if (snap._tag === "WaitingForInteraction") return { latched: true, waiting: true }
      yield* interruptActiveStream(scope.activeStreamRef)
      yield* scope.interruptToolWork
      return { latched: true, waiting: false }
    }).pipe(scope.interruptSemaphore.withPermits(1))
    if (!reached.waiting) return reached.latched
    // Resume the parked turn so it ends as interrupted, unless something
    // else resumes it first; then the latch already stops it, and the
    // interrupt does not wait for the permit that turn holds.
    const resume = Effect.gen(function* () {
      const state = yield* scope.inbox.phase
      if (state._tag !== "WaitingForInteraction") return
      if (Predicate.isNotUndefined(messageId) && state.message.id !== messageId) return
      yield* resumeWaiting(state)
    }).pipe(Effect.uninterruptible, scope.sideMutationSemaphore.withPermits(1))
    const resumedElsewhere = scope.inbox.changes.pipe(
      Stream.filter((loop) => loop.state._tag !== "WaitingForInteraction"),
      Stream.runHead,
      Effect.asVoid,
    )
    yield* Effect.raceFirst(resume, resumedElsewhere)
    return true
  })

  /**
   * Run a start as the loop's own fiber and wait for it.
   *
   * A start waits for the side-mutation permit, and its caller can be
   * interrupted in that wait. The start is the loop's job, not the caller's:
   * it runs in the loop scope, so an interrupted caller only stops waiting.
   * The start still spends its reservation or takes the queued item, and
   * only closing the loop stops it. The permit wait stays interruptible for
   * that close; the move to the next phase does not.
   */
  const startInLoop = (
    start: Effect.Effect<void, AgentLoopError>,
  ): Effect.Effect<Fiber.Fiber<void, AgentLoopError>> =>
    Effect.forkIn(
      start.pipe(Effect.uninterruptible, scope.sideMutationSemaphore.withPermits(1)),
      scope.loopScope,
      { startImmediately: true },
    )

  /** Wait for a start; a start that the loop's close stopped fails its caller. */
  const awaitStart = (fiber: Fiber.Fiber<void, AgentLoopError>) =>
    Fiber.await(fiber).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.fail(
            new AgentLoopError({
              message: `Agent loop closed before its turn started: ${scope.sessionId}/${scope.branchId}`,
            }),
          )
        }
        return Effect.failCause(exit.cause)
      }),
    )

  /** Take the next queued item and start it, both under the permit. */
  const startNextIfIdle = Effect.fn("AgentLoop.startNextIfIdle")(() =>
    startInLoop(
      Effect.gen(function* () {
        const next = yield* scope.inbox.takeIfIdle
        if (Option.isNone(next)) return
        yield* scope.turnInterruption.beginTurn
        yield* advanceOrIdle(next)
      }),
    ).pipe(Effect.flatMap(awaitStart)),
  )

  /**
   * Admit one item and, when the admission reserved the start, start it. The
   * admission and the fork of the start are one uninterruptible step, so a
   * reservation always has a start that will spend it. Nothing else can spend
   * it or move the phase first: every other start refuses past a reservation,
   * and every other phase move needs a turn that is running or parked.
   */
  const admitAndStart = Effect.fn("AgentLoop.admitAndStart")(function* (
    item: QueuedTurnItem,
    options: { readonly queueOnly: boolean },
  ) {
    const admitted = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const reserved = yield* scope.inbox.admit(item, options)
        if (Option.isNone(reserved)) return { reserved, start: Option.none() }
        const start = yield* startInLoop(
          scope.turnInterruption.beginTurn.pipe(Effect.andThen(advanceOrIdle(Option.some(item)))),
        )
        return { reserved, start: Option.some(start) }
      }),
    )
    if (Option.isSome(admitted.start)) yield* awaitStart(admitted.start.value)
    return admitted.reserved
  })

  /**
   * Start the turn a restart cut short. Only a loop that is opening calls
   * this: no turn has run and no admission has reached it, so it is idle and
   * holds no reservation. The item needs no admission either — it may still
   * sit in the in-flight slot, and its turn clears that slot when it settles.
   */
  const startRecovered = Effect.fn("AgentLoop.startRecovered")((item: QueuedTurnItem) =>
    startInLoop(
      scope.turnInterruption.beginTurn.pipe(Effect.andThen(advanceOrIdle(Option.some(item)))),
    ).pipe(Effect.flatMap(awaitStart)),
  )

  const respondInteraction = Effect.fn("AgentLoop.respondInteraction")(
    (requestId: InteractionRequestId) =>
      Effect.gen(function* () {
        const state = yield* scope.inbox.phase
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
        // The same turn goes on: an interrupt that came while it was parked
        // still stops it.
        yield* resumeWaiting(state)
      }).pipe(scope.sideMutationSemaphore.withPermits(1)),
  )

  return {
    turnWorkerLoop,
    startNextIfIdle,
    startRecovered,
    admitAndStart,
    interruptActiveStream: interruptActiveStream(scope.activeStreamRef),
    interrupt,
    stopLatch,
    respondInteraction,
    withdrawAdmittedTurn,
    withSideMutation: <A, E, R2>(effect: Effect.Effect<A, E, R2>): Effect.Effect<A, E, R2> =>
      effect.pipe(scope.sideMutationSemaphore.withPermits(1)),
  }
}

// ── agent-loop.behavior ─────────────────────────────────────────────────────

type AgentLoopRuntimeServices =
  | SessionStorage
  | SessionOperationStorage
  | MessageStorage
  | EventStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ModelRegistry
  | ToolRunner
  | EventStore
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

type AgentLoopBehavior = {
  /** The persistence-failure epoch now; a waiter records it before it starts. */
  persistenceFailureEpoch: Effect.Effect<number>
  /** Fails with the first queue-write failure recorded after `epoch`. */
  persistenceFailureAfter: (epoch: number) => Effect.Effect<void, AgentLoopError>
  /**
   * Everything this branch has accepted and not yet answered. The behavior
   * does not restate the inbox's verbs: a caller that wants to admit, steer,
   * withdraw or read the queue asks the inbox itself.
   */
  inbox: LoopInbox
  /**
   * The newest user message whose turn never completed, with what admitted
   * it; what a reopened loop resumes.
   */
  incompleteUserTurn: Effect.Effect<Option.Option<QueuedTurnItem>>
  /** Whether this session has ever written to the branch; a cold loop with history wakes. */
  hasPriorHistory: Effect.Effect<boolean>
  /**
   * Withdraw a follow-up the loop may already have admitted. The inbox alone
   * cannot answer this: an item the worker has claimed has left the queue, so
   * the withdrawal has to reach the admission gate as well.
   */
  withdrawFollowUp: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  /** The profile for one run; its opener says whether a client opened it (`turnCanAsk`). */
  resolveTurnProfile: (run: RunOpener) => Effect.Effect<AgentLoopTurnProfile, never, Scope.Scope>
  /**
   * Branch-lifetime services: the cell kernel, the model context ledger, and
   * every extension Resource declared with `scope: "branch"`. Extension leaves
   * invoked outside a turn (an `extension.request` RPC, say) must be given this
   * context, or a branch Resource resolves as "Service not found". Built on
   * first use from the session's profile.
   */
  branchContext: Effect.Effect<Context.Context<never>>
  /** Start the turn a restart cut short; only an opening loop calls it. */
  startRecovered: (item: QueuedTurnItem) => Effect.Effect<void, AgentLoopError>
  /** Take the next queued item and start it in one permit region, as the loop's own fiber. */
  startNextIfIdle: () => Effect.Effect<void, AgentLoopError>
  /** Admit one item and start it when the admission reserved the start. */
  admitAndStart: (
    item: QueuedTurnItem,
    options: { readonly queueOnly: boolean },
  ) => Effect.Effect<Option.Option<RunningState>, AgentLoopError | FollowUpQueueFull>
  /** `by` names the stop's requester; the first interrupt of a turn records it. */
  interrupt: (messageId?: MessageId, by?: string) => Effect.Effect<boolean, AgentLoopError>
  /** The running turn's stop latch, read once; none when no turn runs. */
  stopLatch: () => Effect.Effect<Option.Option<StopLatch>>
  respondInteraction: (requestId: InteractionRequestId) => Effect.Effect<void, AgentLoopError>
  withSideMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Mark the per-entity behavior ready to accept state mutations. */
  start: Effect.Effect<void, AgentLoopError>
  /** Fork the extensions' `loopOpen` hooks as the loop's own fiber; the opening loop calls it once. */
  runOpenHooks: Effect.Effect<void>
  /** Resolves once the loop scope is closed. */
  awaitExit: Effect.Effect<void>
  close: Effect.Effect<void>
}

const causeToAgentLoopError = (cause: Cause.Cause<unknown>) => {
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
  clientRequest?: ClientRequestGrant
}) => Effect.Effect<void, AgentLoopError | FollowUpQueueFull | StorageError>

/** Removes a queued follow-up by its source; false when absent or already running. */
type DequeueFollowUp = (input: {
  sessionId: SessionId
  branchId: BranchId
  sourceId: string
}) => Effect.Effect<boolean, AgentLoopError>

/**
 * Steers the loop's own branch re-entrantly. The grant is read at admission,
 * inside the caller, so a client request's steer is admitted while it is live.
 */
type InterjectCommand = Extract<SteerCommandType, { readonly _tag: "Interject" }>

type SteerOwnBranch = (
  command: InterjectCommand,
  clientRequest: Option.Option<ClientRequestGrant>,
) => Effect.Effect<void, AgentLoopError>

interface AgentLoopFollowUpService {
  readonly enqueue: EnqueueFollowUp
  readonly dequeue: DequeueFollowUp
  readonly steer: SteerOwnBranch
}

class AgentLoopFollowUp extends Context.Service<AgentLoopFollowUp, AgentLoopFollowUpService>()(
  "@gent/core/src/runtime/agent-loop/AgentLoopFollowUp",
) {}

// ── residency ───────────────────────────────────────────────────────────────

/**
 * Keeps one branch's cluster entity resident while anything holds it.
 *
 * The cluster reaper passivates an entity that is idle past its limit (one
 * minute), and a passivated entity closes its runtime-state stream and its
 * branch scope. Three things hold a loop resident: a running turn, a client
 * that watches the loop's runtime state, and an extension hold
 * (`Session.holdResident`, which a pending wake timer takes). A watch that
 * held nothing would end a minute into an idle stretch, and the client would
 * reconnect and rebuild the loop each time; a timer that held nothing would
 * stop with the branch scope and never fire.
 *
 * The holds are counted, because the entity has one keep-alive switch: the
 * first hold turns it on and the last release turns it off. An entity with
 * no hold passivates as before. The local test actor has no cluster and no
 * reaper, so there a hold does nothing.
 */
interface AgentLoopResidencyService {
  /** Holds the entity resident until the enclosing scope closes. */
  readonly held: Effect.Effect<void, never, Scope.Scope>
}

class AgentLoopResidency extends Context.Service<AgentLoopResidency, AgentLoopResidencyService>()(
  "@gent/core/src/runtime/agent-loop/AgentLoopResidency",
) {}

/**
 * Counts holds on one switch: the first hold switches it on, the last
 * release switches it off. A hold whose switch-on failed installs no release,
 * so it takes its count back: the next hold switches on again.
 */
export const makeHoldCount = (switchTo: (enabled: boolean) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const holds = yield* Ref.make(0)
    const permit = yield* Semaphore.make(1)
    const acquire = Effect.gen(function* () {
      const previous = yield* Ref.getAndUpdate(holds, (count) => count + 1)
      if (previous !== 0) return
      yield* switchTo(true).pipe(Effect.onError(() => Ref.update(holds, (count) => count - 1)))
    }).pipe(permit.withPermits(1))
    const release = Effect.gen(function* () {
      const remaining = yield* Ref.updateAndGet(holds, (count) => count - 1)
      if (remaining === 0) yield* switchTo(false)
    }).pipe(permit.withPermits(1))
    return AgentLoopResidency.of({ held: Effect.acquireRelease(acquire, () => release) })
  })

/** One residency per entity; built in the entity's own context. */
const makeAgentLoopResidency = Effect.gen(function* () {
  const entityContext = yield* Effect.context<Entity.CurrentAddress>()
  const sharding = yield* Effect.serviceOption(Sharding.Sharding)
  return yield* makeHoldCount((enabled) =>
    Option.match(sharding, {
      onNone: () => Effect.void,
      onSome: (service) =>
        Entity.keepAlive(enabled).pipe(
          Effect.provideService(Sharding.Sharding, service),
          Effect.provideContext(entityContext),
        ),
    }),
  )
})

/**
 * Per-(sessionId, branchId) loop behavior factory.
 *
 * Yields layer-level services directly inside its Effect body — the actor
 * does not pre-bundle them into a deps record. The factory returns
 * `Effect<AgentLoopBehavior, never, R>` whose R-channel is the full union of
 * services consumed by the loop, propagating cleanly to the actor layer.
 */
const makeAgentLoopBehavior = (
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
  | ApprovalService
  | SqlClient.SqlClient
  | ModelResolver
  | ExtensionRegistry
  | EventStore
  | ToolRunner
  | ProcessLocalToolReplay
  | AgentLoopFollowUp
  | AgentLoopResidency
  | ConfigService
  | ModelRegistry
  | ChildProcessSpawner
  | GentPlatform
  | RuntimeEnvironment
  | FileSystem.FileSystem
  | Path.Path
> =>
  Effect.gen(function* () {
    yield* ModelResolver
    const extensionRegistry = yield* ExtensionRegistry
    const eventStore = yield* EventStore
    yield* ToolCallBindingStorage
    yield* TurnRecordStorage
    yield* ToolRunner
    const followUp = yield* AgentLoopFollowUp
    const approval = yield* ApprovalService
    const messageStorage = yield* MessageStorage
    const recoveryEvents = yield* EventStorage
    const host = yield* makeExtensionHostPlatform
    const runtimeContext = yield* captureAgentLoopRuntimeContext
    // A running turn holds the entity resident: its worker is detached from
    // the request that started it.
    const residency = yield* AgentLoopResidency

    const publishEvent = (event: AgentEvent) =>
      eventStore.publish(event).pipe(asAgentLoopError(`Failed to publish ${event._tag}`))

    // Reaching another branch goes through its actor. The client tags exist
    // where an actor client layer is in scope; a bare test actor has none,
    // and a facade call from there dies naming the absence.
    const platform = yield* GentPlatform
    const loopClient = yield* Effect.serviceOption(AgentLoop.Context)
    const provideLoopClient = <A, E>(
      effect: Effect.Effect<A, E, AgentLoopClientServices>,
    ): Effect.Effect<A, E> =>
      Option.match(loopClient, {
        onNone: () => Effect.die("AgentLoop client not available"),
        onSome: (client) =>
          effect.pipe(
            Effect.provideService(AgentLoop.Context, client),
            Effect.provideService(GentPlatform, platform),
          ),
      })
    const isOwnBranch = (target: { readonly sessionId: SessionId; readonly branchId: BranchId }) =>
      target.sessionId === sessionId && target.branchId === branchId

    const hostProvider = yield* makeExtensionHostContextProvider({
      host,
      sessionControl: {
        queueFollowUp: (
          input,
        ): Effect.Effect<void, AgentLoopError | FollowUpQueueFull | StorageError> => {
          // The loop's own queue is re-entrant; another branch's is its actor's.
          if (isOwnBranch(input)) return followUp.enqueue(input)
          return queueFollowUpOn(input).pipe(provideLoopClient)
        },
        dequeueFollowUp: (input): Effect.Effect<boolean, AgentLoopError> => {
          if (isOwnBranch(input)) return followUp.dequeue(input)
          return dequeueFollowUpOn(input).pipe(provideLoopClient)
        },
        send: (input) => submitUserMessage(input).pipe(provideLoopClient),
        steer: (command, clientRequest) => {
          // A steer into the loop's own branch is admitted here, before the
          // caller goes on, so a client request's grant is read while it runs.
          // Any other target is its actor's, and carries no grant.
          if (command._tag === "Interject" && isOwnBranch(command)) {
            return followUp.steer(command, Option.fromUndefinedOr(clientRequest))
          }
          return steerLoop(command).pipe(provideLoopClient)
        },
        stopMessage: (input) => stopMessageOn(input).pipe(provideLoopClient),
        holdResident: residency.held,
      },
    })

    const resolveProfile = (opener: RunOpener) =>
      provideAgentLoopRuntimeContext(runtimeContext)(
        resolveSessionTurnProfile({
          opener,
          sessionId,
          branchId,
          profileCache,
          hostProvider,
          defaults: { baseSections },
        }).pipe(Effect.provideService(ExtensionRegistry, extensionRegistry)),
      )

    const loopScope = yield* Effect.scope
    const turnInterruption = yield* makeTurnInterruption
    // Branch-owned turn services: the cell kernel, the model context ledger, and
    // every extension Resource declared with `scope: "branch"`. All three share
    // `loopScope`, so they are rebuilt per loop and interrupted when the branch
    // closes. Process-scope Resources are not collected here — they belong to
    // the process graph host and outlive this scope.
    const branchTools = yield* CurrentBranchToolFeature
    const branchCwd = yield* sessionWorkingDirectory(sessionId)
    const branchToolContext = yield* Layer.build(
      branchTools.branchLayer({ sessionId, branchId, cwd: branchCwd, turnInterruption }),
    ).pipe(Scope.provide(loopScope))
    // The branch's Resources come from the session's profile, the same one its
    // turns and requests resolve: the extensions set up for the session's cwd,
    // over that profile's process services. The launch registry would build
    // another project's Resources. They are built on the first turn or
    // request, not at open, so a control-plane write (a cancel, an answer to
    // no question) never resolves a profile.
    const branchResourceLock = yield* Semaphore.make(1)
    interface BranchResources {
      readonly context: typeof branchToolContext
      /** The extensions this loop suspends: their branch Resources failed. */
      readonly suspended: ReadonlyArray<FailedExtension>
    }
    const branchResources = yield* Ref.make(Option.none<BranchResources>())
    const buildBranchResources = Effect.gen(function* () {
      const built = yield* Ref.get(branchResources)
      if (Option.isSome(built)) return built.value
      // The branch's Resources are built over this profile's services, so
      // the loop holds its lease until the branch closes. No turn's origin
      // reaches them.
      const profile = yield* resolveProfile(
        RunOpener.cases.Turn.make({ openedByClient: true }),
      ).pipe(Scope.provide(loopScope))
      // Each extension's branch Resources build on their own, as its process
      // Resources do. One that fails, or that needs a service a failed one
      // would have built, is named once in the log and in the transcript and
      // is suspended for this loop, as a failed process Resource suspends its
      // extension for the profile; every other extension and the branch's
      // turns go on.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const started = yield* buildScopeResources({
            extensions: profile.turnExtensionRegistry.getResolved().extensions,
            scope: "branch",
            context: Context.merge(
              Context.makeUnsafe<unknown>(new Map()),
              Option.getOrElse(
                Option.fromUndefinedOr(profile.turnCapabilityContext),
                Context.empty,
              ),
            ),
            parent: loopScope,
            restore: (effect) => effect,
          })
          yield* Effect.forEach(
            started.failed,
            ({ failure, message }) =>
              publishEvent(
                ErrorOccurred.make({
                  sessionId,
                  branchId,
                  error: `Extension "${failure.manifest.id}" branch resource failed to start: ${message}`,
                  notice: true,
                }),
              ).pipe(
                Effect.catchEager((error) =>
                  Effect.logWarning("failed to publish ErrorOccurred").pipe(
                    Effect.annotateLogs({ error: String(error) }),
                  ),
                ),
              ),
            { discard: true },
          )
          const resources: BranchResources = {
            context: Context.merge(branchToolContext, started.context),
            suspended: started.failed.map(({ failure }) => failure),
          }
          yield* Ref.set(branchResources, Option.some(resources))
          return resources
        }),
      )
    }).pipe(branchResourceLock.withPermits(1))
    const branchContext = Effect.map(buildBranchResources, ({ context }) => context)
    // A turn, a request and a hook read the registry with the loop's
    // suspended extensions left out, so none of their tools, requests or
    // hooks is offered or dispatched. One registry per profile: a profile
    // resolves to the same registry until a config edit replaces it.
    const suspendedRegistries = new WeakMap<ExtensionRegistryService, ExtensionRegistryService>()
    const resolveTurnProfile = (opener: RunOpener) =>
      Effect.gen(function* () {
        const profile = yield* resolveProfile(opener)
        const { suspended } = yield* buildBranchResources
        if (suspended.length === 0) return profile
        const registry = profile.turnExtensionRegistry
        const narrowed = Option.getOrElse(
          Option.fromUndefinedOr(suspendedRegistries.get(registry)),
          () => {
            const resolved = suspendExtensions(registry.getResolved(), suspended)
            return ExtensionRegistry.of({ getResolved: () => resolved })
          },
        )
        suspendedRegistries.set(registry, narrowed)
        return { ...profile, turnExtensionRegistry: narrowed }
      })
    const turnWorkerQueue = yield* TxQueue.unbounded<RunningState>()
    const activeStreamRef = yield* Ref.make<Option.Option<ActiveStreamHandle>>(Option.none())
    const turnLedger = yield* makeTurnLedger
    // A tool holding branch-scoped work exposes how to cancel it. A branch
    // whose tools are all stateless has nothing to cancel.
    const branchWork = Context.getOption(branchToolContext, BranchToolWork)
    const interruptToolWork = Option.match(branchWork, {
      onNone: () => Effect.void,
      onSome: (work) => work.cancel,
    })
    const stopToolWork = Option.match(branchWork, {
      onNone: () => Effect.void,
      onSome: (work) => work.stop,
    })
    const initialLoopState = buildIdleState()
    const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
      buildInitialAgentLoopState({ state: initialLoopState, queue: initialQueue }),
    )
    const queuePersistenceSemaphore = yield* Semaphore.make(1)
    const persistenceFailures = yield* TxSubscriptionRef.make<PersistenceFailureMark>({
      epoch: 0,
      error: Option.none(),
    })
    const closed = yield* Deferred.make<void>()
    const startedRef = yield* Ref.make(false)

    const inbox = yield* makeLoopInbox({
      sessionId,
      branchId,
      loopRef,
      queuePersistenceSemaphore,
      persistenceFailures,
      startedRef,
      turnSettled: (messageId) =>
        messageStorage.getMessage(messageId).pipe(
          Effect.map((message) => Predicate.isNotUndefined(message?.turnDurationMs)),
          asAgentLoopError("Cannot read submitted message"),
        ),
      messageStored: (messageId) =>
        messageStorage
          .getMessage(messageId)
          .pipe(
            Effect.map(Predicate.isNotUndefined),
            asAgentLoopError("Cannot read steered message"),
          ),
    })

    const recordTurnFailure = (cause: Cause.Cause<unknown>, messageId: MessageId) =>
      TxSubscriptionRef.update(loopRef, (s) => ({
        ...s,
        turnFailure: {
          epoch: turnFailureEpoch(s) + 1,
          messageId,
          error: causeToAgentLoopError(cause),
        },
      }))

    const turnExecution = yield* makeAgentLoopTurnExecution({
      sessionId,
      branchId,
      resolveTurnProfile,
      activeStreamRef,
      turnLedger,
      turnInterruption,
      inbox,
      branchContext,
    })

    const worker = makeAgentLoopWorker({
      sessionId,
      branchId,
      sideMutationSemaphore,
      interruptSemaphore: yield* Semaphore.make(1),
      turnWorkerQueue,
      activeStreamRef,
      turnInterruption,
      interruptToolWork,
      inbox,
      admissionGateRef: yield* Ref.make(emptyAdmissionGate),
      recordTurnFailure,
      publishEvent,
      completeFailedTurn: (state) =>
        turnExecution.completeFailedTurn(state).pipe(
          Effect.scoped,
          provideAgentLoopRuntimeContext(runtimeContext),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to complete the failed turn").pipe(
              Effect.annotateLogs({ error: Cause.pretty(cause) }),
            ),
          ),
        ),
      interactionAnswered: approval.answered,
      runTurn: (state) =>
        residency.held.pipe(
          Effect.andThen(branchContext),
          // The turn's profile lease ends with the turn.
          Effect.flatMap((context) =>
            turnExecution.runTurn(state).pipe(Effect.provideContext(context), Effect.scoped),
          ),
          Effect.scoped,
        ),
      sessionAgent: sessionAgentName(sessionId),
      loopScope,
    })

    const turnWorkerFiber = yield* Ref.make(Option.none<Fiber.Fiber<void>>())
    const startTurnWorker = Effect.forkIn(
      provideAgentLoopRuntimeContext(runtimeContext)(worker.turnWorkerLoop),
      loopScope,
      {
        startImmediately: true,
      },
    ).pipe(Effect.flatMap((fiber) => Ref.set(turnWorkerFiber, Option.some(fiber))))

    const start = Effect.suspend(
      Effect.fn("AgentLoop.start")(function* () {
        if (yield* Ref.getAndSet(startedRef, true)) return
        yield* startTurnWorker
      }),
    )

    // The `loopOpen` hooks, as the loop's own fiber, off the caller's path:
    // the op that opened the loop never waits on them, and a profile that
    // fails to resolve only logs. Nothing here takes the side-mutation
    // permit, which a running turn holds for its whole length: the profile
    // cache resolves under its own place lock and the branch Resources build
    // under `branchResourceLock`. So the hooks run beside a turn resumed at
    // open, a hook that never returns delays no turn, and a follow-up a hook
    // queues on this branch starts at once. No client opened the run, so a
    // hook cannot ask.
    const runOpenHooks = Effect.forkIn(
      Effect.gen(function* () {
        const { profile, context } = yield* Effect.all({
          profile: resolveTurnProfile(RunOpener.cases.Turn.make({ openedByClient: false })),
          context: branchContext,
        })
        yield* profile.turnExtensionRegistry
          .getResolved()
          .extensionHooks.emitLoopOpen.pipe(
            runAgentLoopTurnProfile(profile),
            Effect.provideContext(context),
          )
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.logWarning("agent-loop.loop-open-hooks.failed").pipe(
            Effect.annotateLogs({ sessionId, branchId, error: Cause.pretty(cause) }),
          ),
        ),
      ),
      loopScope,
    ).pipe(Effect.asVoid)

    const close = Effect.suspend(
      Effect.fn("AgentLoop.close")(function* () {
        yield* worker.interruptActiveStream
        // Closing stops the turn as a crash would: nothing it runs records an
        // outcome. Branch tool work can hold the turn past a fiber interrupt
        // (a cell runs uninterruptibly so a cancel can report), so the turn is
        // interrupted first and its tool work is then stopped; without the
        // stop, closing the scope would wait for that work forever.
        const turn = yield* Ref.get(turnWorkerFiber)
        if (Option.isSome(turn))
          yield* Effect.forkDetach(Fiber.interrupt(turn.value), { startImmediately: true })
        yield* stopToolWork
        yield* Deferred.succeed(closed, void 0).pipe(Effect.ignore)
        yield* Scope.close(loopScope, Exit.void)
      }),
    ).pipe(Effect.ignore)

    // A failed recovery read leaves the loop cold; the log names the read.
    const recoveryReadFailed =
      (read: string) =>
      (error: EventStorageError): Effect.Effect<ReadonlyArray<never>> =>
        Effect.logWarning("agent-loop.recovery-read-failed").pipe(
          Effect.annotateLogs({ read, sessionId, branchId, error: String(error) }),
          Effect.as([]),
        )

    const hasPriorHistory = messageStorage.listMessages(branchId).pipe(
      Effect.catchEager(recoveryReadFailed("messages")),
      Effect.map((messages) => messages.some((message) => message.sessionId === sessionId)),
    )

    const incompleteUserTurn = Effect.gen(function* () {
      const envelopes = yield* recoveryEvents
        .listEvents({ sessionId, branchId })
        .pipe(Effect.catchEager(recoveryReadFailed("events")))
      const completed = new Set(
        envelopes.flatMap(({ event }) => {
          if (event._tag === "TurnCompleted" && Predicate.isNotUndefined(event.messageId)) {
            return [event.messageId]
          }
          return []
        }),
      )
      // A failed turn writes no receipt. Once a later turn has completed, the
      // failed one is history the branch moved past, so only messages received
      // after the last completion can be the turn a restart cut short.
      const lastCompletion = envelopes.findLastIndex(({ event }) => event._tag === "TurnCompleted")
      // Continuation prompts, handoff markers, and model-change notices are
      // the runtime's own user-role lines; none completes on its own and none
      // must start a turn of its own.
      const incomplete = envelopes.slice(lastCompletion + 1).flatMap(({ event }) => {
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
      const message = incomplete.at(-1)
      if (Predicate.isUndefined(message)) return Option.none<QueuedTurnItem>()
      // The session names the agent the resumed turn runs as.
      return Option.some<QueuedTurnItem>({ message })
    })

    return {
      persistenceFailureEpoch: Effect.map(
        TxSubscriptionRef.get(persistenceFailures),
        (mark) => mark.epoch,
      ),
      persistenceFailureAfter: (epoch) =>
        Effect.gen(function* () {
          const after = (mark: PersistenceFailureMark) => mark.epoch > epoch
          const current = yield* TxSubscriptionRef.get(persistenceFailures)
          let mark = Option.liftPredicate(current, after)
          if (Option.isNone(mark)) {
            mark = yield* TxSubscriptionRef.changesStream(persistenceFailures).pipe(
              Stream.filter(after),
              Stream.runHead,
            )
          }
          return yield* Option.getOrElse(
            Option.flatMap(mark, (value) => value.error),
            () => new AgentLoopError({ message: "Queue persistence failure stream ended" }),
          )
        }),
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
      startRecovered: worker.startRecovered,
      startNextIfIdle: worker.startNextIfIdle,
      admitAndStart: worker.admitAndStart,
      interrupt: worker.interrupt,
      stopLatch: worker.stopLatch,
      respondInteraction: worker.respondInteraction,
      withSideMutation: worker.withSideMutation,
      start,
      runOpenHooks,
      awaitExit: Deferred.await(closed),
      close,
    } satisfies AgentLoopBehavior
  })

// ── actor ───────────────────────────────────────────────────────────────────

/**
 * `AgentLoop` as `Actor.fromEntity`.
 *
 * **Op surface:** request/reply only. `Subscribe` and `Snapshot` are NOT
 * actor ops:
 * - `Actor.fromEntity` is request/reply; `OperationHandle.watch` is
 *   polling status, not a live state stream.
 * - State subscription stays behavior-owned and is exposed through
 *   `Actor.registerState`.
 *
 * **Entity ID** keys per `(sessionId, branchId)` so all ops for one branch
 * share an actor instance. Handler concurrency is intentionally unbounded;
 * behavior-owned queue and actor-owned semaphore serialize turn execution, durable queue,
 * and side-effect lanes.
 *
 * **Single source of truth for routing:** an op that carries a domain payload
 * owning its own `(sessionId, branchId)` has no top-level routing fields — the
 * embedded payload IS the authority. Ops with no embedded payload
 * (`RespondInteraction` and the branch commands) carry explicit target fields.
 *
 * **Execution id key** per op: the `AgentLoop` entity in
 * `domain/agent-loop.ts` names each op's key and whether it is persisted.
 * A message-carrying op (`Submit`, `SubmitAndWait`, `SubmitDurable`,
 * `QueueFollowUp`) keys by `message.id` through `messageTarget`. Every
 * branch command keys by `commandId` through `branchTarget`; `Steer` keys
 * by `commandId` too, and `RespondInteraction` by `requestId`.
 *
 * Schemas reuse gent's existing domain (`Message`, `RunSpec`,
 * `SteerCommand`) rather than introducing a parallel envelope shape.
 *
 * @module
 */

/** The running turn's stop latch: its message, whether a stop latched, and who asked first. */
interface StopLatch {
  readonly messageId: MessageId
  readonly stopped: boolean
  readonly by: Option.Option<string>
}

const isActiveLoopState = Predicate.or(
  Predicate.isTagged("Running"),
  Predicate.isTagged("WaitingForInteraction"),
)

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

const waitForMessageReleased = (
  behavior: AgentLoopBehavior,
  messageId: MessageId,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { inbox } = behavior
    const current = yield* inbox.read
    if (!inbox.holds(current, messageId)) return
    yield* inbox.changes.pipe(
      Stream.filter((state) => !inbox.holds(state, messageId)),
      Stream.runHead,
    )
  })

const failTurnFailureState = (failure: NonNullable<AgentLoopState["turnFailure"]>) => {
  if (Schema.is(AgentLoopError)(failure.error)) return Effect.fail(failure.error)
  return Effect.fail(
    new AgentLoopError({ message: "Agent loop turn failed", cause: failure.error }),
  )
}

/** A failure recorded after `baseline` for the turn that carried `messageId`. */
const hasTurnFailureFor =
  (baseline: number, messageId: MessageId) =>
  (
    state: AgentLoopState,
  ): state is AgentLoopState & {
    readonly turnFailure: NonNullable<AgentLoopState["turnFailure"]>
  } =>
    Predicate.isNotUndefined(state.turnFailure) &&
    state.turnFailure.epoch > baseline &&
    state.turnFailure.messageId === messageId

const waitForTurnFailureAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
  messageId: MessageId,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const hasNewTurnFailure = hasTurnFailureFor(baseline, messageId)
    const current = yield* behavior.inbox.read
    if (hasNewTurnFailure(current)) return yield* failTurnFailureState(current.turnFailure)
    const next = yield* behavior.inbox.changes.pipe(
      Stream.filter(hasNewTurnFailure),
      Stream.runHead,
    )
    if (Option.isSome(next)) return yield* failTurnFailureState(next.value.turnFailure)
    return yield* new AgentLoopError({
      message: "Agent loop turn failure stream ended",
    })
  })

const failIfTurnFailedAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
  messageId: MessageId,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.inbox.read
    if (hasTurnFailureFor(baseline, messageId)(current)) {
      return yield* failTurnFailureState(current.turnFailure)
    }
  })

/** Where a waiter starts: the turn- and persistence-failure marks before its turn. */
interface WaitBaseline {
  readonly turn: number
  readonly persistence: number
}

/** Record the failure marks to wait from. Take this *before* starting the turn. */
const waitBaseline = (behavior: AgentLoopBehavior): Effect.Effect<WaitBaseline> =>
  Effect.all({
    turn: Effect.map(behavior.inbox.read, turnFailureEpoch),
    persistence: behavior.persistenceFailureEpoch,
  })

/**
 * Wait until the loop has released `messageId`, started after `baseline`.
 *
 * A turn is over when the loop no longer holds its message: not starting it,
 * not running it, not waiting on it, and not keeping it queued. That is read
 * off the loop's own state, so no event subscription can miss it. Failure is
 * a monotonic counter (`turnFailure.epoch`); a caller records where it stood
 * before starting the turn (`waitBaseline`). A later mark that names the
 * caller's message is this turn's failure; a mark for another message is not.
 *
 * It ends three ways, and all three end the wait: the loop lets the message
 * go (its own turn ran, or it left the queue unrun), the turn fails, or
 * persistence fails. Follow-ups never merge, so no other message's turn
 * releases this one. The last two fail the effect. Only a persistence failure
 * breaks the loop, so only that one runs `onPersistenceFailure`: after a turn
 * failure the worker has already moved on to the next queued turn.
 */
const awaitTurnCompletion = (
  behavior: AgentLoopBehavior,
  baseline: WaitBaseline,
  messageId: MessageId,
  onPersistenceFailure: (
    failure: Effect.Effect<void, AgentLoopError>,
  ) => Effect.Effect<void, AgentLoopError>,
): Effect.Effect<void, AgentLoopError> =>
  Effect.raceFirst(
    Effect.raceFirst(
      waitForMessageReleased(behavior, messageId),
      waitForTurnFailureAfterEpoch(behavior, baseline.turn, messageId),
    ),
    onPersistenceFailure(behavior.persistenceFailureAfter(baseline.persistence)),
  ).pipe(
    // Release wins the race even when the turn failed on its way there,
    // so the failure is checked once more after the race settles.
    Effect.andThen(failIfTurnFailedAfterEpoch(behavior, baseline.turn, messageId)),
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
    // The client requests running on this branch (`RequestExtension`). An
    // admission reads a message's grant here under `clientRequestPermit`,
    // which a request's end takes too: the message gets the client origin
    // only if its request still ran when it was admitted.
    const liveClientRequests = yield* Ref.make<ReadonlySet<ClientRequestGrant>>(new Set())
    const clientRequestPermit = yield* Semaphore.make(1)
    // Serializes per-entity `handle` rebuild. The actor mailbox is
    // `concurrency: "unbounded"`, so concurrent ops can both observe a
    // closed loop and race into `openLoop`, leaking the first behavior's
    // fibers and leaving `lifecycleRef` holding a state the other built.
    const startupSemaphore = yield* Semaphore.make(1)
    const residency = yield* makeAgentLoopResidency
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

    /**
     * A loop or persistence failure closes the loop before the error reaches
     * the caller. A refusal (`FollowUpQueueFull`) is an answer, not a broken
     * loop: the loop and its running turn go on.
     */
    const orCleanup =
      (handle: AgentLoopBehavior) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        effect.pipe(
          Effect.catchEager((error) => {
            if (Schema.is(FollowUpQueueFull)(error)) return Effect.fail(error)
            return closeBehavior(handle).pipe(Effect.andThen(Effect.fail(error)))
          }),
        )

    // Typed reentrant-only handle lookup. The only legitimate caller is the
    // `AgentLoopFollowUp` enqueue implementation provided to the behavior — it
    // fires from inside the behavior itself (during turn execution), so
    // `lifecycleRef` provably holds `Open` by then. Mailbox handlers
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
        // An incomplete turn is a stored user message, so history answers first
        // and the event-log scan runs only for a branch with no messages.
        if (yield* handle.hasPriorHistory) return true
        return Option.isSome(yield* handle.incompleteUserTurn)
      })

    const startNextQueuedTurnIfIdle = (
      handle: AgentLoopBehavior,
      options?: { readonly startupPermitHeld?: boolean },
    ) =>
      handle.startNextIfIdle().pipe(
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

    // Both call sites supply an already-resolved `handle`, so no admission can
    // reach the behavior without going through one of the two safe lookups:
    //   - the `AgentLoopFollowUp` enqueue implementation reads
    //     `reentrantHandle` lazily — it fires during turn execution, well after
    //     `openLoop` published the handle, so the read is provably safe.
    //   - the `QueueFollowUp` mailbox handler resolves it via `ensureStarted`.
    type FollowUpInput = {
      /** Keys the message id so repeated admissions and later removal target one item. */
      readonly sourceId?: string
      readonly message?: MessageType
      readonly content?: string
      readonly metadata?: MessageMetadata
      readonly wake?: boolean
      readonly clientRequest?: ClientRequestGrant
    }

    /**
     * Admits an item with its origin decided at this point. A grant still live
     * (see `liveClientRequests`) gives it the client origin; the check and the
     * admission hold the permit a request's end takes, so no request ends
     * between them. Returns what `admit` returns and the item it admitted.
     */
    const admitWithOrigin = <A, E, R>(
      item: QueuedTurnItem,
      grant: Option.Option<ClientRequestGrant>,
      admit: (item: QueuedTurnItem) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const live = yield* Ref.get(liveClientRequests)
        const running = Option.filter(grant, (value) => live.has(value))
        const admitted = Option.match(running, {
          onNone: () => item,
          onSome: (): QueuedTurnItem => ({
            ...item,
            message: { ...item.message, metadata: { ...item.message.metadata, fromClient: true } },
          }),
        })
        return { result: yield* admit(admitted), item: admitted }
      }).pipe(clientRequestPermit.withPermits(1))

    /** Marks a client request running on this branch until the scope closes. */
    const holdClientRequest = Effect.fn("AgentLoopActor.holdClientRequest")(function* () {
      const grant = ClientRequestGrant.make(yield* platform.randomId)
      yield* Effect.acquireRelease(
        Ref.update(liveClientRequests, (live) => new Set([...live, grant])),
        () =>
          Ref.update(liveClientRequests, (live) => {
            const rest = new Set(live)
            rest.delete(grant)
            return rest
          }).pipe(clientRequestPermit.withPermits(1)),
      )
      return grant
    })

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
      // A settled or running message id is not a new turn: the inbox makes a
      // replayed follow-up a no-op.
      const item = yield* buildFollowUpItem(input)
      yield* admitWithOrigin(item, Option.fromUndefinedOr(input.clientRequest), (admitted) =>
        handle.inbox.admit(admitted, { queueOnly: true }),
      )
      // A retained facade can enqueue after its original turn has ended.
      // The actor owns this wake; an active mutation releases its permit first.
      if (yield* shouldWake(handle, input)) yield* wakeAfterPermit(handle)
    })

    /**
     * Mailbox admission from another branch or the runtime. It carries no
     * client grant: a grant is live only on its own branch, whose follow-ups
     * take the re-entrant path (`admitFollowUp`).
     */
    const enqueueMessage = Effect.fn("AgentLoopActor.enqueueMessage")(function* (
      handle: AgentLoopBehavior,
      input: FollowUpInput,
    ) {
      const wasAlreadyWarm = yield* markWrite
      const item = yield* buildFollowUpItem(input)
      yield* handle.admitAndStart(item, { queueOnly: !wasAlreadyWarm }).pipe(orCleanup(handle))
      if (!wasAlreadyWarm && (yield* shouldWake(handle, input))) {
        yield* startNextQueuedTurnIfIdle(handle)
      }
    })

    /**
     * Ask for a turn from inside a caller that holds the side-mutation permit.
     * The start is forked, so it waits for that permit instead of deadlocking.
     */
    const wakeAfterPermit = (handle: AgentLoopBehavior): Effect.Effect<void> =>
      Ref.set(wakeRequested, true).pipe(
        Effect.andThen(drainWake(handle).pipe(provideActorWorkspace, Effect.forkIn(actorScope))),
        Effect.asVoid,
      )

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
        queueStorage
          .getQueueState(sessionId, branchId)
          .pipe(asAgentLoopError(`Failed to load loop queue for ${sessionId}/${branchId}`)),
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
            Effect.provideService(AgentLoopResidency, residency),
            Effect.provideService(AgentLoopFollowUp, {
              enqueue: (input) =>
                reentrantHandle.pipe(Effect.flatMap((h) => admitFollowUp(h, input))),
              steer: (command, clientRequest) =>
                reentrantHandle.pipe(
                  Effect.flatMap((h) => admitInterjection(h, command, clientRequest)),
                ),
              dequeue: (input) =>
                reentrantHandle.pipe(
                  Effect.flatMap((h) =>
                    h.withdrawFollowUp(
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
          Effect.andThen(handle.inbox.writeInitialQueue),
          Effect.andThen(
            Effect.gen(function* () {
              const incompleteTurn = yield* handle.incompleteUserTurn
              if (Option.isSome(incompleteTurn)) {
                yield* handle
                  .startRecovered(incompleteTurn.value)
                  .pipe(
                    Effect.catchEager((error) =>
                      closeBehaviorWithHeldStartupPermit(handle).pipe(
                        Effect.andThen(Effect.fail(error)),
                      ),
                    ),
                  )
                return
              }
              const recovered = wantsWakeOnRecovery(initialQueue)
              if (Option.isNone(recovered)) return
              if (recovered.value.unconditional || (yield* handle.hasPriorHistory)) {
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
        return
      }
      // Once per build, after startup and the recovery above: the extensions
      // repair what a previous process or a closed loop left on this branch.
      yield* handle.runOpenHooks
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
      return yield* handle.inbox.runtimeState
    })

    // A watcher holds the entity resident for as long as it watches: a
    // passivated entity would end the stream under an idle client.
    const registeredStateChanges = Stream.unwrap(
      Effect.gen(function* () {
        yield* rejectIfTerminated
        yield* residency.held
        const handle = yield* ensureStarted
        return handle.inbox.runtimeChanges.pipe(Stream.interruptWhen(handle.awaitExit))
      }),
    )

    const registeredState = Actor.State.makeReadable(
      currentRegisteredState.pipe(provideActorWorkspace),
      registeredStateChanges.pipe(Stream.provideService(CurrentWorkspaceId, brandedWorkspaceId)),
    )
    yield* Actor.registerState(registeredState)

    /**
     * Admit one submitted turn: target check, warm mark, reservation, and the
     * start when the reservation grants it.
     */
    const admitTurn = (handle: AgentLoopBehavior, operation: TurnSubmissionInput) =>
      Effect.gen(function* () {
        yield* ensureTarget(operation.message)
        yield* markWrite
        const item: QueuedTurnItem = { message: operation.message }
        yield* handle.admitAndStart(item, { queueOnly: false }).pipe(orCleanup(handle))
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
      const baseline = yield* waitBaseline(handle)
      yield* admitTurn(handle, operation)
      // This turn is done when the loop lets *its* message go, which can
      // happen while the loop stays busy with a follow-up.
      yield* awaitTurnCompletion(handle, baseline, operation.message.id, orCleanup(handle))
    })

    const isCancellation = Predicate.or(
      Predicate.isTagged("Cancel"),
      Predicate.isTagged("Interrupt"),
    )

    const interjectionItem = Effect.fn("AgentLoopActor.interjectionItem")(function* (
      commandId: ActorCommandId,
      command: InterjectCommand,
    ) {
      const message = Message.cases.interjection.make({
        id: interjectionMessageId(commandId),
        sessionId: command.sessionId,
        branchId: command.branchId,
        role: "user",
        parts: [Prompt.textPart({ text: command.message })],
        createdAt: yield* DateTime.nowAsDate,
        ...Record.filter({ metadata: command.metadata }, Predicate.isNotUndefined),
      })
      const item: QueuedTurnItem = { message, wake: command.wake }
      return item
    })

    /**
     * Queue one steering item, and start a turn for it when the caller asked to
     * wake an idle branch.
     *
     * Steering joins the running turn at its next step boundary; the open
     * stream is not interrupted. An idle branch has no turn to join, so the
     * item waits in the queue where `queue.get` can still show it. Only a
     * caller that asked to wake gets a turn of its own — the same signal
     * recovery uses at startup. `inbox.steer` answers with the state the queue
     * had *before* the append, so the idle test is made on that: a caller that
     * read the state first and steered second would race a turn that ended in
     * between.
     *
     * `start` is the one difference between the two callers. The mailbox
     * starts at once (`startNextQueuedTurnIfIdle`: the take and the start run
     * in one permit region). A re-entrant caller holds the
     * side-mutation permit, so its wake starts after the permit is released
     * (`wakeAfterPermit`).
     */
    const interject = Effect.fn("AgentLoopActor.interject")(function* (
      handle: AgentLoopBehavior,
      commandId: ActorCommandId,
      command: InterjectCommand,
      clientRequest: Option.Option<ClientRequestGrant>,
      start: (handle: AgentLoopBehavior) => Effect.Effect<void, AgentLoopError>,
    ) {
      const item = yield* interjectionItem(commandId, command)
      const { result: before } = yield* admitWithOrigin(item, clientRequest, (admitted) =>
        handle.inbox.steer(admitted),
      )
      if (command.wake !== true || Option.isNone(before) || before.value._tag !== "Idle") return
      yield* start(handle)
    })

    /**
     * Re-entrant steer into this branch (see `admitFollowUp`). The origin is
     * decided at admission, while the caller runs.
     */
    const admitInterjection = Effect.fn("AgentLoopActor.admitInterjection")(function* (
      handle: AgentLoopBehavior,
      command: InterjectCommand,
      clientRequest: Option.Option<ClientRequestGrant>,
    ) {
      yield* ensureTarget(command)
      yield* markWrite
      yield* interject(
        handle,
        ActorCommandId.make(command.requestId),
        command,
        clientRequest,
        wakeAfterPermit,
      )
    })

    /**
     * Stop what one message opens. The recorded cancellation stops a turn
     * that has not started yet when it starts; a steer no step has read yet
     * is taken back; a running turn the message opened is interrupted.
     * True when this stop reached the message in one of these places. False
     * when the loop no longer holds it (its turn ended, or a step already
     * joined it into a turn that another message opened), or when an earlier
     * interrupt already stops its turn: that stop is not this one's doing.
     * A steer taken back is this stop's news, with one exception: when an
     * earlier stop from the same `requester` already stops the turn the steer
     * waited to join, that stop answered true and its caller reports the
     * branch, so the take-back answers false and the branch is named once.
     * A take-back while any other stop (the user's, another branch's) stops
     * that turn is true: nobody else tells the requester its steer is gone.
     */
    const stopMessage = Effect.fn("AgentLoopActor.stopMessage")(function* (
      messageId: MessageId,
      requester: Option.Option<StopRequester>,
    ) {
      const by = Option.map(requester, stopRequesterKey)
      // Read before the cancellation is recorded: a turn that starts after
      // the record latches itself, and that latch is this stop's.
      const latch = yield* Option.match(lifecycleHandle(yield* Ref.get(lifecycleRef)), {
        onNone: () => Effect.succeed(Option.none<StopLatch>()),
        onSome: (loop) => loop.stopLatch(),
      })
      // An interrupt already stops the turn this message opened.
      const alreadyStopping = Option.exists(
        latch,
        (turn) => turn.messageId === messageId && turn.stopped,
      )
      // The stop that first latched the running turn came from this requester.
      const requesterStopsTurn = Option.exists(latch, (turn) =>
        Option.exists(by, (key) => Option.contains(turn.by, key)),
      )
      yield* operations
        .cancelTurn({ sessionId, branchId, messageId })
        .pipe(asAgentLoopError("Cannot record targeted cancellation"))
      const handle = yield* ensureStarted
      const takenBack = yield* handle.inbox.withdrawSteering(messageId)
      // An idle loop has no turn to interrupt: the interrupt reports false.
      const interrupted = yield* handle
        .interrupt(messageId, Option.getOrUndefined(by))
        .pipe(orCleanup(handle))
      const held = handle.inbox.holds(yield* handle.inbox.read, messageId)
      return (takenBack && !requesterStopsTurn) || (!alreadyStopping && (interrupted || held))
    })

    const applySteer = Effect.fn("AgentLoopActor.applySteer")(function* (
      commandId: ActorCommandId,
      command: SteerCommandType,
    ) {
      yield* ensureTarget(command)
      yield* markWrite
      if (isCancellation(command) && Predicate.isNotUndefined(command.messageId)) {
        yield* stopMessage(command.messageId, Option.none())
        return
      }
      const handle = yield* ensureStarted

      switch (command._tag) {
        case "Cancel":
        case "Interrupt":
          // A cancellation that names a message took the `stopMessage` path above.
          if (isActiveLoopState(yield* handle.inbox.phase)) {
            yield* handle.interrupt().pipe(orCleanup(handle))
          }
          return

        case "Interject":
          // A mailbox steer carries no client grant: it came from outside the branch.
          yield* interject(handle, commandId, command, Option.none(), (h) =>
            startNextQueuedTurnIfIdle(h),
          )
          return
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
            // A reply to a loop that lost its turn (a restart mid-interaction)
            // needs nothing here: opening the loop resumed that turn, and it
            // reads the stored answer when it reaches the interaction.
            const phase = yield* handle.inbox.phase
            if (phase._tag !== "WaitingForInteraction") return
            yield* handle.respondInteraction(operation.requestId).pipe(orCleanup(handle))
          }).pipe(provideActorWorkspace),
      ),
      DrainQueue: Effect.fn("AgentLoop.DrainQueue")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          branchCommand(operation, markWrite, (handle) => handle.inbox.drain),
      ),
      RemoveFollowUp: Effect.fn("AgentLoop.RemoveFollowUp")(
        ({ operation }: HandlerRequest<RemoveFollowUpInput>) =>
          branchCommand(operation, markWrite, (handle) =>
            handle.withdrawFollowUp(operation.messageId),
          ),
      ),
      StopMessage: Effect.fn("AgentLoop.StopMessage")(
        ({ operation }: HandlerRequest<StopMessageInput>) =>
          branchCommand(operation, markWrite, () =>
            stopMessage(operation.messageId, Option.fromUndefinedOr(operation.requester)),
          ),
      ),
      GetQueue: Effect.fn("AgentLoop.GetQueue")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          branchCommand(operation, rejectIfTerminated, (handle) => handle.inbox.snapshot),
      ),
      GetState: Effect.fn("AgentLoop.GetState")(
        ({ operation }: HandlerRequest<BranchCommandInput>) =>
          branchCommand(operation, rejectIfTerminated, (handle) => handle.inbox.runtimeState),
      ),
      RequestExtension: Effect.fn("AgentLoop.RequestExtension")(
        ({ operation }: HandlerRequest<RequestExtensionInput>) =>
          Effect.gen(function* () {
            yield* ensureTarget(operation)
            const handle = yield* ensureStarted
            // A request comes from a client, which can answer, and sends to
            // its own branch as that client until the request ends.
            const grant = yield* holdClientRequest()
            const environment = yield* handle.resolveTurnProfile(
              RunOpener.cases.ClientRequest.make({ grant }),
            )
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
              Effect.provideContext(yield* handle.branchContext),
            )
            // A request that does not change this branch's loop state answers
            // while a turn runs; anything else waits for the permit the turn holds.
            if (rpcRegistry.answersDuringTurn(operation.extensionId, capabilityId)) {
              return yield* run
            }
            // A follow-up the request admitted wakes the loop from
            // `admitFollowUp`, which forks the drain in the actor scope.
            return yield* run.pipe(handle.withSideMutation)
          }).pipe(
            // The request's profile lease ends with the request.
            Effect.scoped,
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
            // mailbox closed before we got here, `lifecycleRef` may still be
            // `Building`; skip cleanup in that case rather than triggering a
            // rebuild via `ensureStarted`.
            const handle = lifecycleHandle(yield* Ref.get(lifecycleRef))
            if (Option.isSome(handle)) {
              yield* closeBehavior(handle.value)
            }
          }).pipe(provideActorWorkspace),
      ),
    })
  })

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
          // `concurrency: "unbounded"` keeps short ops (RespondInteraction,
          // Steer) from waiting on unrelated mailbox handlers.
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
