import { Match, Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { ToolCapability } from "../../domain/capability/tool.js"
import {
  AgentName,
  RunSpecSchema,
  DEFAULT_AGENT_NAME,
  type AgentDefinition as AgentDefinitionType,
  type DriverRef,
  type DriverSource,
  type AgentName as AgentNameType,
  type ReasoningEffort as ReasoningEffortType,
} from "../../domain/agent.js"
import { Message } from "../../domain/message.js"
import { ModelId, type ModelId as ModelIdType } from "../../domain/model.js"
import {
  FollowUpQueueEntryInfo,
  QueueSnapshot,
  SteeringQueueEntryInfo,
  type QueueEntryInfo,
} from "../../domain/queue.js"
import { UsageSchema } from "../../domain/event.js"
import {
  InteractionRequestId,
  type InteractionRequestId as InteractionRequestIdType,
} from "../../domain/ids.js"
import { messageText, getSingleText } from "./agent-loop.utils.js"

export class AgentLoopError extends Schema.TaggedError<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// ── Queue ──

export const QueuedTurnItemSchema = Schema.Struct({
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
  /** The admitter asked for a turn even when the branch has no prior history. */
  wake: Schema.optional(Schema.Boolean),
})
export type QueuedTurnItem = typeof QueuedTurnItemSchema.Type

/** True when any admitted item carries an explicit wake request. */
export const queueRequestsWake = (queue: LoopQueueState): boolean =>
  queue.followUp.some((item) => item.wake === true) ||
  queue.steering.some((item) => item.wake === true) ||
  queue.inFlight?.wake === true

export const LoopQueueState = Schema.Struct({
  steering: Schema.Array(QueuedTurnItemSchema),
  followUp: Schema.Array(QueuedTurnItemSchema),
  inFlight: Schema.optional(QueuedTurnItemSchema),
})
export type LoopQueueState = typeof LoopQueueState.Type

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
    Option.isSome(getSingleText(existing.message)) && Option.isSome(getSingleText(incoming.message))
  )
}

const mergeQueuedFollowUp = (
  existing: QueuedTurnItem,
  incoming: QueuedTurnItem,
): QueuedTurnItem => {
  const existingText = getSingleText(existing.message)
  const incomingText = getSingleText(incoming.message)
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

  if (String(item.message.id).startsWith("follow-up:")) {
    return [...queue, item]
  }

  const last = queue[queue.length - 1]
  if (Predicate.isUndefined(last) || !canBatchQueuedFollowUp(last, item)) {
    return [...queue, item]
  }
  return [...queue.slice(0, -1), mergeQueuedFollowUp(last, item)]
}

const toQueueEntry = (
  tag: "steering" | "follow-up",
  item: QueuedTurnItem,
): Option.Option<QueueEntryInfo> => {
  const content = messageText(item.message)
  if (content === "") return Option.none()
  const fields = {
    id: item.message.id,
    content,
    createdAt: item.message.createdAt.getTime(),
  }
  if (!Predicate.isUndefined(item.agentOverride)) {
    Object.assign(fields, { agentOverride: item.agentOverride })
  }
  if (tag === "steering") {
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
      Option.match(toQueueEntry("steering", item), {
        onNone: () => [],
        onSome: (entry) => [entry],
      }),
    ),
    followUp: followUpItems.flatMap((item) =>
      Option.match(toQueueEntry("follow-up", item), {
        onNone: () => [],
        onSome: (entry) => [entry],
      }),
    ),
  })

export const emptyLoopQueueState = (): LoopQueueState => ({
  steering: [],
  followUp: [],
})

export const drainVisibleQueueItems = (queue: LoopQueueState): LoopQueueState => ({
  steering: [],
  followUp: [],
  inFlight: queue.inFlight,
})

export const appendSteeringItem = (queue: LoopQueueState, item: QueuedTurnItem): LoopQueueState => {
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

export const appendFollowUpQueueState = (
  queue: LoopQueueState,
  item: QueuedTurnItem,
): LoopQueueState => {
  const inFlight = Option.fromUndefinedOr(queue.inFlight)
  if (Option.isSome(inFlight) && inFlight.value.message.id === item.message.id) return queue
  return {
    ...queue,
    followUp: appendFollowUpItem(queue.followUp, item),
  }
}

export const clearQueueState = (_queue: LoopQueueState): LoopQueueState => emptyLoopQueueState()

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

export const takeNextQueuedTurn = (queue: LoopQueueState, createdAt: Date): QueuedTurnTake => {
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

export const countQueuedFollowUps = (queue: LoopQueueState) => queue.followUp.length

export const clearInFlightQueuedTurn = (
  queue: LoopQueueState,
  messageId: QueuedTurnItem["message"]["id"],
): LoopQueueState => {
  const inFlight = Option.fromUndefinedOr(queue.inFlight)
  if (Option.isSome(inFlight) && inFlight.value.message.id === messageId) {
    return {
      steering: queue.steering,
      followUp: queue.followUp,
    }
  }
  return queue
}

// ── Shared field groups ──

const LoopStateBaseFields = {
  currentAgent: Schema.optional(AgentName),
}

const RunningTurnFields = {
  ...LoopStateBaseFields,
  message: Message,
  startedAtMs: Schema.Finite,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

// ── Turn types (not persisted in machine state) ──

export const AssistantDraftSchema = Schema.Struct({
  text: Schema.String,
  reasoning: Schema.String,
  toolCalls: Schema.Array(Prompt.ToolCallPart),
  usage: Schema.optional(UsageSchema),
})

export type AssistantDraft = typeof AssistantDraftSchema.Type

export type ResolvedTurn = {
  currentTurnAgent: AgentNameType
  messages: ReadonlyArray<Message>
  systemPrompt: string
  modelId: ModelIdType
  reasoning?: ReasoningEffortType
  temperature?: number
  tools?: ReadonlyArray<ToolCapability>
  agent?: AgentDefinitionType
  driver?: DriverRef
  /** Origin of {@link driver} — set by `resolveAgentDriver` in the loop's
   *  `resolveTurnContext`. ACP-aware prompt slots read this
   *  to detect external dispatch and rewrite the prompt accordingly. */
  driverSource?: DriverSource
}

// ── Phase-tagged loop state (flat, actor-owned) ──
//
// Replaces the `effect-machine` `State()` / `Machine` driver from
// pre-. The loop is a single fiber + Phase Ref now; this enum is
// the source of truth for "where is the loop?" while the actor entity is
// materialized.

export const LoopState = Schema.TaggedUnion({
  /** No turn in progress. */
  Idle: LoopStateBaseFields,
  /** Agentic loop running: resolve → stream → tools → repeat. */
  Running: RunningTurnFields,
  /** Cold state: a tool requested human approval. No turn fiber. */
  WaitingForInteraction: {
    ...RunningTurnFields,
    currentTurnAgent: AgentName,
    pendingRequestId: InteractionRequestId,
    pendingToolCallId: Schema.String,
  },
})

// ── Type aliases ──

export type LoopState = Schema.Schema.Type<typeof LoopState>
export type IdleState = Extract<LoopState, { _tag: "Idle" }>
export type RunningState = Extract<LoopState, { _tag: "Running" }>
export type WaitingForInteractionState = Extract<LoopState, { _tag: "WaitingForInteraction" }>

interface QueuedTurnTake {
  readonly queue: LoopQueueState
  readonly nextItem: Option.Option<QueuedTurnItem>
}

// ── Runtime projection (transport/UI) ──
// Public runtime state mirrors the machine directly. No parallel `phase/status`
// matrix — the discriminator is the state. Owned here so the public projection
// has a single canonical declaration; `session-runtime.ts` re-exports.

export const SessionRuntimeStateSchema = Schema.TaggedUnion({
  Idle: {
    agent: AgentName,
    queue: QueueSnapshot,
  },
  Running: {
    agent: AgentName,
    queue: QueueSnapshot,
  },
  WaitingForInteraction: {
    agent: AgentName,
    queue: QueueSnapshot,
  },
})
export type SessionRuntimeState = Schema.Schema.Type<typeof SessionRuntimeStateSchema>

export const SessionRuntimeMetrics = Schema.Struct({
  turns: Schema.Finite,
  tokens: Schema.Finite,
  toolCalls: Schema.Finite,
  retries: Schema.Finite,
  durationMs: Schema.Finite,
  /** Cumulative USD cost: sum of `StreamEnded.costUsd` across the session's
   * event log. Cost is frozen into each event at emit time against the
   * pricing snapshot available then, so replays always sum to the same
   * total regardless of later registry refreshes. */
  costUsd: Schema.Finite,
  /** Input-tokens reported by the most recent `StreamEnded` (for "how close
   * to the context window are we right now" — sums don't answer that). */
  lastInputTokens: Schema.Finite,
  /** Model id reported by the most recent `StreamEnded` (drives the model
   * name label in the TUI). `undefined` until the first stream ends. */
  lastModelId: Schema.optional(ModelId),
})
export type SessionRuntimeMetrics = typeof SessionRuntimeMetrics.Type

// ── State builders ──

export const buildIdleState = (params?: { currentAgent?: AgentNameType }): IdleState =>
  LoopState.cases.Idle.make({
    currentAgent: params?.currentAgent,
  })

export const buildRunningState = (
  base: { currentAgent?: AgentNameType },
  item: QueuedTurnItem,
  options: { startedAtMs: number },
): RunningState =>
  LoopState.cases.Running.make({
    currentAgent: base.currentAgent,
    message: item.message,
    startedAtMs: options.startedAtMs,
    agentOverride: item.agentOverride,
    runSpec: item.runSpec,
    interactive: item.interactive,
  })

export const toWaitingForInteractionState = (params: {
  state: RunningState
  currentTurnAgent: AgentNameType
  pendingRequestId: InteractionRequestIdType
  pendingToolCallId: string
}): WaitingForInteractionState =>
  LoopState.cases.WaitingForInteraction.make({
    currentAgent: params.state.currentAgent,
    message: params.state.message,
    startedAtMs: params.state.startedAtMs,
    agentOverride: params.state.agentOverride,
    runSpec: params.state.runSpec,
    interactive: params.state.interactive,
    currentTurnAgent: params.currentTurnAgent,
    pendingRequestId: params.pendingRequestId,
    pendingToolCallId: params.pendingToolCallId,
  })

export const updateCurrentAgentOnState = (
  state: LoopState,
  currentAgent: AgentNameType,
): LoopState =>
  Match.type<LoopState>().pipe(
    Match.tagsExhaustive({
      Idle: (value) => LoopState.cases.Idle.make({ ...value, currentAgent }),
      Running: (value) => LoopState.cases.Running.make({ ...value, currentAgent }),
      WaitingForInteraction: (value) =>
        LoopState.cases.WaitingForInteraction.make({ ...value, currentAgent }),
    }),
  )(state)

export const queueSnapshotFromQueueState = (queue: LoopQueueState): QueueSnapshot =>
  toQueueSnapshot(queue.steering, queue.followUp)

export const queueContainsContent = (
  queue: ReadonlyArray<QueuedTurnItem>,
  content: string,
): boolean => queue.some((item) => messageText(item.message).includes(content))

// ── Runtime state projection ──

export const runtimeStateFromLoopState = (
  state: LoopState,
  queue: LoopQueueState,
): SessionRuntimeState => {
  const agent = Option.getOrElse(
    Option.fromUndefinedOr(state.currentAgent),
    () => DEFAULT_AGENT_NAME,
  )
  const queueSnapshot = queueSnapshotFromQueueState(queue)

  return Match.type<LoopState>().pipe(
    Match.tagsExhaustive({
      Idle: () => SessionRuntimeStateSchema.cases.Idle.make({ agent, queue: queueSnapshot }),
      Running: () => SessionRuntimeStateSchema.cases.Running.make({ agent, queue: queueSnapshot }),
      WaitingForInteraction: () =>
        SessionRuntimeStateSchema.cases.WaitingForInteraction.make({
          agent,
          queue: queueSnapshot,
        }),
    }),
  )(state)
}

// ── Aggregate (single-Ref shape) ──
//
// Replaces the stateRef / queueRef / runtimeStateRef projection mirror set
// with one source of truth. The FSM driver still owns the LoopState
// transition table; this aggregate is the per-session memory the loop
// reads/writes through a single SubscriptionRef. `runtimeState` derives
// from `state` + `queue` at the watchState boundary — never stored.

export interface AgentLoopState {
  readonly state: LoopState
  readonly queue: LoopQueueState
  readonly stateEpoch: number
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
  stateEpoch: 0,
})

export const projectRuntimeState = (s: AgentLoopState): SessionRuntimeState =>
  runtimeStateFromLoopState(s.state, s.queue)
