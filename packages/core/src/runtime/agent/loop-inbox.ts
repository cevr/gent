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

import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
  TxSubscriptionRef,
  type Semaphore,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { DEFAULT_AGENT_NAME } from "../../domain/agent.js"
import type { BranchId, MessageId, SessionId } from "../../domain/ids.js"
import {
  emptyLoopQueueState,
  FollowUpQueueEntryInfo,
  type LoopQueueState,
  Message,
  messagePartsTextLines,
  messageSingleText,
  type QueuedTurnItem,
  type QueueEntryInfo,
  QueueSnapshot,
  SteeringQueueEntryInfo,
} from "../../domain/message.js"
import { AgentLoopQueueStorage } from "../../storage/storage.js"
import {
  AgentLoopError,
  asAgentLoopError,
  buildRunningState,
  SessionRuntimeStateSchema,
  type LoopState,
  type RunningState,
  type SessionRuntimeState,
} from "../../domain/agent-loop.js"

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
export const turnFailureEpoch = (state: AgentLoopState): number =>
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
