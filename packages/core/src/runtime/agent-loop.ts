import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
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
  type ActorCommandId,
  type BranchId,
  type InteractionRequestId,
  MessageId,
  RpcId,
  type SessionId,
} from "../domain/ids.js"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type AgentName, DEFAULT_AGENT_NAME, type RunSpec } from "../domain/agent.js"
import {
  emptyLoopQueueState,
  FollowUpQueueEntryInfo,
  isRuntimeUserMessage,
  type LoopQueueState,
  Message,
  type MessageMetadata,
  messagePartsTextLines,
  messageSingleText,
  type QueuedTurnItem,
  type QueueEntryInfo,
  QueueSnapshot,
  SteeringQueueEntryInfo,
} from "../domain/message.js"
import {
  AgentLoopQueueStorage,
  EventStorage,
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
  type HandlerRequest,
  type LoopState,
  type MessageType,
  parseEntityId,
  type QueueFollowUpInput,
  queueFollowUpOn,
  type RemoveFollowUpInput,
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
import { type AgentEvent, ErrorOccurred, EventPublisher } from "../domain/event.js"
import { causeChainMessage } from "../domain/guards.js"
import {
  type ActiveStreamHandle,
  type AgentLoopTurnProfile,
  interjectionMessageIdForCommand,
  makeAgentLoopTurnExecution,
  makeTurnLedger,
  runAgentLoopTurnProfile,
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
import { turnBoundary, withWideEvent } from "./wide-event-boundary.js"
import { Entity, Sharding, ShardingConfig } from "effect/unstable/cluster"
import type { SqlClient } from "effect/unstable/sql"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  buildResourceLayer,
  type CurrentExtensionHostContext,
  DriverRegistry,
  ExtensionHostContextProvider,
  ExtensionRegistry,
  makeExtensionHostContextProvider,
  makeExtensionHostPlatform,
  resolveTurnProfile as resolveSessionTurnProfile,
  SessionProfileCache,
  type SessionProfileCacheService,
} from "./extension-host.js"
import type { ConfigService } from "./config.js"
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
 * instance. `restoreSession(sessionId)` clears the marker.
 *
 * Encore actor handlers run per (entityType, entityId) where entityId
 * is `(sessionId, branchId)`. This governance lives ABOVE the per-
 * entity scope so the same `terminatedSessionsRef` Set is consulted
 * by every entity instance for the session.
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
 * One module owns admission, follow-up batching, steering, the durable
 * checkpoint, the wake decision, and the question "does this loop still hold
 * that message". Before this module those six concerns were split across the
 * actor, the behavior, the pure state algebra, and the turn executor, and the
 * queue representation — `steering`, `followUp`, `inFlight` — was read
 * directly by all four. Both peers that implement durable steering give it a
 * module of its own: opencode `packages/core/src/session/inbox.ts` and codex
 * `codex-rs/core/src/session/input_queue.rs`.
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
 * The persisted shape lives in `domain/queue.ts` with the snapshot it projects
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

const canBatchQueuedFollowUp = (existing: QueuedTurnItem, incoming: QueuedTurnItem): boolean => {
  if (
    !Predicate.isUndefined(existing.agentOverride) ||
    !Predicate.isUndefined(incoming.agentOverride)
  )
    return false
  if (!Predicate.isUndefined(existing.runSpec) || !Predicate.isUndefined(incoming.runSpec)) {
    return false
  }
  if (!Predicate.isUndefined(existing.interactive) || !Predicate.isUndefined(incoming.interactive))
    return false
  if (existing.message.role !== "user" || incoming.message.role !== "user") return false
  if (existing.message._tag === "interjection" || incoming.message._tag === "interjection") {
    return false
  }
  return (
    !Predicate.isUndefined(messageSingleText(existing.message.parts)) &&
    !Predicate.isUndefined(messageSingleText(incoming.message.parts))
  )
}

const mergeQueuedFollowUp = (
  existing: QueuedTurnItem,
  incoming: QueuedTurnItem,
): QueuedTurnItem => {
  const existingText = Option.fromUndefinedOr(messageSingleText(existing.message.parts))
  const incomingText = Option.fromUndefinedOr(messageSingleText(incoming.message.parts))
  if (Option.isNone(existingText) || Option.isNone(incomingText)) return incoming

  const merged: QueuedTurnItem = {
    ...existing,
    message: Message.cases.regular.make({
      id: existing.message.id,
      sessionId: existing.message.sessionId,
      branchId: existing.message.branchId,
      role: existing.message.role,
      parts: [Prompt.textPart({ text: `${existingText.value}\n${incomingText.value}` })],
      createdAt: existing.message.createdAt,
      turnDurationMs: existing.message.turnDurationMs,
      metadata: existing.message.metadata,
    }),
  }
  if (incoming.wake === true) return { ...merged, wake: true }
  return merged
}

const appendFollowUpItem = (
  queue: ReadonlyArray<QueuedTurnItem>,
  item: QueuedTurnItem,
): QueuedTurnItem[] => {
  const existingIndex = queue.findIndex((queued) => queued.message.id === item.message.id)
  if (existingIndex >= 0) {
    return queue.map((queued, index) => {
      if (index === existingIndex) {
        return item
      }
      return queued
    })
  }

  if (item.keyed === true) return [...queue, item]

  const last = queue[queue.length - 1]
  if (Predicate.isUndefined(last) || !canBatchQueuedFollowUp(last, item)) {
    return [...queue, item]
  }
  return [...queue.slice(0, -1), mergeQueuedFollowUp(last, item)]
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
  if (!Predicate.isUndefined(item.agentOverride)) {
    Object.assign(fields, { agentOverride: item.agentOverride })
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

/**
 * A steering item a running step may take.
 *
 * An item carrying an agent override or a run spec needs a turn profile of its
 * own, which a step boundary cannot build, so it waits for a turn boundary.
 */
const deliverableAtStep = (item: QueuedTurnItem) =>
  Predicate.isUndefined(item.agentOverride) && Predicate.isUndefined(item.runSpec)

/** The loop still owns this message: starting, running, waiting, or queued. */
const stateHoldsMessage = (state: LoopState, messageId: MessageId) =>
  state._tag !== "Idle" && state.message.id === messageId

const loopHoldsMessage = (s: AgentLoopState, messageId: MessageId): boolean => {
  const item = (queued: QueuedTurnItem) => queued.message.id === messageId
  return (
    stateHoldsMessage(s.state, messageId) ||
    (Predicate.isNotUndefined(s.startingState) && stateHoldsMessage(s.startingState, messageId)) ||
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
  // One shipped agent. A run narrows it per turn through `agentOverride`; the
  // branch itself never holds another, so the projection names the default.
  const agent = DEFAULT_AGENT_NAME
  const queue = queueSnapshotFromQueueState(s.queue)

  return Match.type<LoopState>().pipe(
    Match.tagsExhaustive({
      Idle: () => SessionRuntimeStateSchema.cases.Idle.make({ agent, queue }),
      Running: () => SessionRuntimeStateSchema.cases.Running.make({ agent, queue }),
      WaitingForInteraction: () =>
        SessionRuntimeStateSchema.cases.WaitingForInteraction.make({ agent, queue }),
    }),
  )(s.state)
}

/**
 * Whether a caller may take a turn for this branch right now.
 *
 * Idle is not enough on its own. `startingState` holds an item another caller
 * already reserved but has not started yet: it has left the queue and has not
 * reached `state`, so a plain idle test cannot see it. A caller that takes a
 * turn past that reservation leaves the reserving caller to find the loop
 * `Running` when it finally starts, with its item in neither the queue nor the
 * transcript. Both admission paths ask this one question.
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

type LoopInboxContext = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly loopRef: TxSubscriptionRef.TxSubscriptionRef<AgentLoopState>
  readonly queuePersistenceSemaphore: Semaphore.Semaphore
  readonly persistenceFailure: Deferred.Deferred<void, AgentLoopError>
  readonly startedRef: Ref.Ref<boolean>
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
   * the turn; `None` means the item is queued and something else will take it.
   */
  readonly admit: (
    item: QueuedTurnItem,
    options: { readonly queueOnly: boolean },
  ) => Effect.Effect<Option.Option<RunningState>, AgentLoopError>
  /** Take the next item only while nothing else holds or has reserved the loop. */
  readonly takeIfIdle: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  /** Take the next item; the caller already owns the turn lane. */
  readonly take: Effect.Effect<Option.Option<QueuedTurnItem>, AgentLoopError>
  /** True when this message was the in-flight admission and is now settled. */
  readonly settle: (messageId: MessageId) => Effect.Effect<boolean, AgentLoopError>
  /**
   * Queue one steering item and answer with the phase the loop was in *before*
   * the append, which is what a caller must test to decide on a wake. Reading
   * the phase separately would race a turn that ended in between.
   */
  readonly steer: (item: QueuedTurnItem) => Effect.Effect<LoopState, AgentLoopError>
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
      Deferred.fail(scope.persistenceFailure, error).pipe(Effect.catchEager(() => Effect.void))

    const commitQueueTransaction = <A>(
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
      }).pipe(scope.queuePersistenceSemaphore.withPermits(1))

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
      return yield* commitQueueTransaction<Option.Option<RunningState> | AgentLoopError>(
        "reserved or queued follow-up",
        (current) => {
          if (current.queue.followUp.length >= FOLLOW_UP_QUEUE_MAX) {
            return {
              value: new AgentLoopError({
                message: `Follow-up queue full (max ${FOLLOW_UP_QUEUE_MAX})`,
              }),
              next: current,
              persist: false,
            }
          }

          const nextQueue = appendFollowUpQueueState(current.queue, item)
          if (options.queueOnly) {
            return {
              value: Option.none(),
              next: { ...current, queue: nextQueue },
              persist: true,
            }
          }

          const projectedState = projectRuntimeState(current)
          if (projectedState._tag !== "Idle" || !canStartTurnNow(current)) {
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
        },
      ).pipe(
        Effect.filterOrFail(
          (value): value is Option.Option<RunningState> => !Schema.is(AgentLoopError)(value),
          (value) => {
            if (Schema.is(AgentLoopError)(value)) return value
            return new AgentLoopError({ message: "Queue transaction returned an invalid value" })
          },
        ),
      )
    })

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
      return yield* commitQueueTransaction("dequeued turn", (s) => {
        if (options.onlyIfIdle && !canStartTurnNow(s)) {
          return { value: Option.none(), next: s, persist: false }
        }
        const { queue, nextItem } = takeNextQueuedTurn(s.queue, queuedCreatedAt)
        return {
          value: nextItem,
          next: { ...s, queue },
          persist: queue !== s.queue,
        }
      })
    })

    const settle = Effect.fn("LoopInbox.settle")((messageId: MessageId) =>
      commitQueueTransaction("cleared in-flight turn", (s) => {
        const queue = clearInFlightQueuedTurn(s.queue, messageId)
        return {
          value: queue !== s.queue,
          next: { ...s, queue },
          persist: queue !== s.queue,
        }
      }),
    )

    const steer = Effect.fn("LoopInbox.steer")((item: QueuedTurnItem) =>
      commitQueueTransaction("queued steering", (s) => ({
        value: s.state,
        next: { ...s, queue: appendSteeringItem(s.queue, item) },
        persist: true,
      })),
    )

    const dropSteeringDelivered = (delivered: ReadonlyArray<QueuedTurnItem>) => {
      if (delivered.length === 0) return Effect.void
      const deliveredIds = new Set<string>(delivered.map((item) => item.message.id))
      return commitQueueTransaction("dropped delivered steering", (s) => {
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

    const deliverSteering = Effect.fn("LoopInbox.deliverSteering")(function* <E, R>(params: {
      readonly finalStep: boolean
      readonly join: (item: QueuedTurnItem) => Effect.Effect<void, E, R>
    }) {
      if (params.finalStep) return false
      const state = yield* TxSubscriptionRef.get(scope.loopRef)
      const items = state.queue.steering.filter(deliverableAtStep)
      for (const item of items) {
        yield* params.join(item)
      }
      yield* dropSteeringDelivered(items)
      return items.length > 0
    })

    const drain = commitQueueTransaction("drained queue", (s) => ({
      value: queueSnapshotFromQueueState(s.queue),
      next: { ...s, queue: drainVisibleQueueItems(s.queue) },
      persist: true,
    })).pipe(Effect.withSpan("LoopInbox.drain"))

    const withdraw = Effect.fn("LoopInbox.withdraw")((messageId: MessageId) =>
      commitQueueTransaction("removed queued follow-up", (s) => {
        const queue = removeQueuedFollowUp(s.queue, messageId)
        return {
          value: queue !== s.queue,
          next: { ...s, queue },
          persist: queue !== s.queue,
        }
      }),
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
      holds: loopHoldsMessage,
      moveToPhase,
    } satisfies LoopInbox
  })

// ── agent-loop.worker ───────────────────────────────────────────────────────

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
  readonly recordTurnFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>
  readonly publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  readonly runTurn: (state: RunningState) => Effect.Effect<TurnOutcome, AgentLoopError | E, R>
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
          currentTurnAgent: outcome.currentTurnAgent,
          pendingRequestId: outcome.pendingRequestId,
          pendingToolCallId: outcome.pendingToolCallId,
        })
        yield* scope.inbox.moveToPhase(next)
        return
      }

      const nextItem = yield* scope.inbox.take
      yield* scope.turnInterruption.beginTurn
      yield* advanceOrIdle(nextItem)
    })

  const failTurnWorker = (cause: Cause.Cause<unknown>): Effect.Effect<void, AgentLoopError> =>
    Effect.gen(function* () {
      yield* scope.recordTurnFailure(cause)
      yield* publishPhaseFailure(cause)
      const nextItem = yield* scope.inbox.take
      yield* scope.turnInterruption.beginTurn
      yield* advanceOrIdle(nextItem)
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
      yield* scope.runTurn(startState).pipe(
        Effect.annotateLogs({ sessionId: scope.sessionId, branchId: scope.branchId }),
        Effect.withSpan("AgentLoop.turn"),
        withWideEvent(
          turnBoundary(
            scope.sessionId,
            scope.branchId,
            startState.agentOverride ?? DEFAULT_AGENT_NAME,
          ),
        ),
        Effect.matchCauseEffect({
          onFailure: (cause) => failTurnWorker(cause).pipe(scope.interruptSemaphore.withPermits(1)),
          onSuccess: (outcome) =>
            finishTurnWorker(startState, outcome).pipe(scope.interruptSemaphore.withPermits(1)),
        }),
        Effect.catchCause((cause) =>
          scope
            .recordTurnFailure(cause)
            .pipe(Effect.andThen(publishPhaseFailure(cause)), Effect.ignore),
        ),
        Effect.ignore,
        Effect.ensuring(releaseAdmission),
      )
    }).pipe(scope.sideMutationSemaphore.withPermits(1))

  /**
   * Drops a turn that was admitted as the next run but has not started.
   * Callers usually hold the side-mutation permit already (extension requests
   * and hooks), so this takes none; the admission gate and the in-flight
   * marker together prove the turn is only queued. The next queued item (if
   * any) takes its place.
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
      yield* advanceOrIdle(yield* scope.inbox.take)
      return true
    }),
  )

  const turnWorkerLoop = TxQueue.take(scope.turnWorkerQueue).pipe(
    Effect.flatMap(runTurnWorker),
    Effect.forever,
    Effect.ignore,
  )

  const interrupt = Effect.fn("AgentLoop.interrupt")(function* (messageId?: MessageId) {
    const waiting = yield* Effect.gen(function* () {
      const snap = yield* scope.inbox.phase
      if (snap._tag === "Idle") return false
      if (Predicate.isNotUndefined(messageId) && snap.message.id !== messageId) return false
      if (snap._tag === "WaitingForInteraction") return true
      yield* scope.turnInterruption.interrupt
      yield* interruptActiveStream(scope.activeStreamRef)
      yield* scope.interruptToolWork
      return false
    }).pipe(scope.interruptSemaphore.withPermits(1))
    if (!waiting) return
    yield* Effect.gen(function* () {
      const state = yield* scope.inbox.phase
      if (state._tag !== "WaitingForInteraction") return
      if (Predicate.isNotUndefined(messageId) && state.message.id !== messageId) return
      yield* scope.turnInterruption.interrupt
      yield* resumeWaiting(state)
    }).pipe(scope.sideMutationSemaphore.withPermits(1))
  })

  const startTurn = Effect.fn("AgentLoop.startTurn")((item: QueuedTurnItem) =>
    Effect.gen(function* () {
      const state = yield* scope.inbox.phase
      if (state._tag !== "Idle") return
      yield* scope.turnInterruption.beginTurn
      yield* advanceOrIdle(Option.some(item))
    }).pipe(scope.sideMutationSemaphore.withPermits(1)),
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
        yield* scope.turnInterruption.beginTurn
        yield* resumeWaiting(state)
      }).pipe(scope.sideMutationSemaphore.withPermits(1)),
  )

  return {
    turnWorkerLoop,
    startTurn,
    interruptActiveStream: interruptActiveStream(scope.activeStreamRef),
    interrupt,
    respondInteraction,
    withdrawAdmittedTurn,
    withSideMutation: <A, E, R2>(effect: Effect.Effect<A, E, R2>): Effect.Effect<A, E, R2> =>
      effect.pipe(scope.sideMutationSemaphore.withPermits(1)),
  }
}

// ── agent-loop.behavior ─────────────────────────────────────────────────────

/**
 * Per-(sessionId, branchId) loop behavior factory.
 *
 * Built by the `AgentLoop` actor for each (sessionId, branchId). Same turn
 * flow as the public `SessionRuntime` boundary, with recursive follow-up
 * queueing supplied as an explicit callback.
 *
 * @module
 */

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

type AgentLoopBehavior = {
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

class AgentLoopFollowUp extends Context.Service<AgentLoopFollowUp, AgentLoopFollowUpService>()(
  "@gent/core/src/runtime/agent-loop/AgentLoopFollowUp",
) {}

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
      extensionRegistry,
      host,
      sessionControl: {
        queueFollowUp: (input): Effect.Effect<void, AgentLoopError | StorageError> => {
          // The loop's own queue is re-entrant; another branch's is its actor's.
          if (isOwnBranch(input)) return followUp.enqueue(input)
          return queueFollowUpOn(input).pipe(provideLoopClient)
        },
        dequeueFollowUp: (input): Effect.Effect<boolean, AgentLoopError> => followUp.dequeue(input),
        send: (input) => submitUserMessage(input).pipe(provideLoopClient),
        steer: (command) => steerLoop(command).pipe(provideLoopClient),
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

// ── agent-loop.actor ────────────────────────────────────────────────────────

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
 * embedded payload IS the authority. Only `Interrupt` (no embedded payload)
 * carries explicit target fields.
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

const isActiveLoopState = Predicate.or(
  Predicate.isTagged("Running"),
  Predicate.isTagged("WaitingForInteraction"),
)

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

const waitForTurnFailureAfterEpoch = (
  behavior: AgentLoopBehavior,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.inbox.read
    if (Predicate.isNotUndefined(current.turnFailure) && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
    const hasNewTurnFailure = (
      state: AgentLoopState,
    ): state is AgentLoopState & {
      readonly turnFailure: NonNullable<AgentLoopState["turnFailure"]>
    } => Predicate.isNotUndefined(state.turnFailure) && state.turnFailure.epoch > baseline
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
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* behavior.inbox.read
    if (Predicate.isNotUndefined(current.turnFailure) && current.turnFailure.epoch > baseline) {
      return yield* failTurnFailureState(current.turnFailure)
    }
  })

/** Record the failure mark to wait from. Take this *before* starting the turn. */
const turnFailureBaseline = (behavior: AgentLoopBehavior): Effect.Effect<number> =>
  Effect.map(behavior.inbox.read, turnFailureEpoch)

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
    // fibers and leaving `lifecycleRef` holding a state the other built.
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
        const reserved = yield* handle.inbox.admit(item, options)
        if (Option.isSome(reserved)) yield* handle.startTurn(item).pipe(orCleanup(handle))
        return reserved
      })

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
        if (Option.isSome(yield* handle.incompleteUserTurn)) return true
        return yield* handle.hasPriorHistory
      })

    const startNextQueuedTurnIfIdle = (
      handle: AgentLoopBehavior,
      options?: { readonly startupPermitHeld?: boolean },
    ) =>
      Effect.gen(function* () {
        const start = yield* handle.inbox.takeIfIdle
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
      yield* handle.inbox.admit(item, { queueOnly: true })
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
            Effect.provideService(AgentLoopFollowUp, {
              enqueue: (input) =>
                reentrantHandle.pipe(Effect.flatMap((h) => admitFollowUp(h, input))),
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
      return yield* handle.inbox.runtimeState
    })

    const registeredStateChanges = Stream.unwrap(
      Effect.gen(function* () {
        yield* rejectIfTerminated
        const handle = yield* ensureStarted
        return handle.inbox.runtimeChanges.pipe(Stream.interruptWhen(handle.awaitExit))
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
        asAgentLoopError("Cannot read submitted message"),
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
        yield* operations
          .cancelTurn({ sessionId, branchId, messageId: command.messageId })
          .pipe(asAgentLoopError("Cannot record targeted cancellation"))
      }
      const handle = yield* ensureStarted

      switch (command._tag) {
        case "Cancel":
        case "Interrupt":
          if (isActiveLoopState(yield* handle.inbox.phase)) {
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
          // startup. `inbox.steer` answers with the state the queue had
          // *before* the append, so the idle test is made on that. The start
          // belongs here, inside the actor: a caller that read the state first
          // and steered second would race a turn that ended in between.
          // `startTurn` re-reads the state under its own permit, so it is a
          // no-op when a turn did begin meanwhile.
          const before = yield* handle.inbox.steer(item)
          if (command.wake !== true || before._tag !== "Idle") return
          const next = yield* handle.inbox.takeIfIdle
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
            // One read decides all three cases. The mailbox is unbounded, so a
            // second read could observe a turn that started in between and take
            // a branch the first read did not test.
            const phase = yield* handle.inbox.phase
            if (phase._tag === "WaitingForInteraction") {
              return yield* handle.respondInteraction(operation.requestId).pipe(orCleanup(handle))
            }
            // A reply to a loop that lost its turn (a restart mid-interaction)
            // resumes that turn instead; the interaction is answered inside it.
            if (phase._tag !== "Idle") return
            const message = yield* handle.incompleteUserTurn
            if (Option.isNone(message)) return
            const baseline = yield* turnFailureBaseline(handle)
            yield* handle.startTurn({ message: message.value }).pipe(orCleanup(handle))
            yield* awaitTurnCompletion(handle, baseline, message.value.id)
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

export { AgentLoop } from "../domain/agent-loop.js"

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
