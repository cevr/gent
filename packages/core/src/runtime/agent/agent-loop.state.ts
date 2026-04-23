import { Schema } from "effect"
import { type ActorRef, Event, State } from "effect-machine"
import type { AnyCapabilityContribution } from "../../domain/capability.js"
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
import { Message, TextPart, ToolCallPart } from "../../domain/message.js"
import type { ModelId as ModelIdType } from "../../domain/model.js"
import {
  FollowUpQueueEntryInfo,
  QueueSnapshot,
  SteeringQueueEntryInfo,
  type QueueEntryInfo,
} from "../../domain/queue.js"
import { UsageSchema } from "../../domain/event.js"
import { TaggedEnumClass } from "../../domain/schema-tagged-enum-class.js"
import { messageText, getSingleText } from "./agent-loop.utils.js"

// ── Queue ──

const QueuedTurnItemSchema = Schema.Struct({
  message: Message,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
})
export type QueuedTurnItem = typeof QueuedTurnItemSchema.Type

export const LoopQueueState = Schema.Struct({
  steering: Schema.Array(QueuedTurnItemSchema),
  followUp: Schema.Array(QueuedTurnItemSchema),
})
export type LoopQueueState = typeof LoopQueueState.Type

const canBatchQueuedFollowUp = (existing: QueuedTurnItem, incoming: QueuedTurnItem): boolean => {
  if (existing.agentOverride !== undefined || incoming.agentOverride !== undefined) return false
  if (existing.runSpec !== undefined || incoming.runSpec !== undefined) {
    return false
  }
  if (existing.interactive !== undefined || incoming.interactive !== undefined) return false
  if (existing.message.role !== "user" || incoming.message.role !== "user") return false
  if (existing.message.kind === "interjection" || incoming.message.kind === "interjection") {
    return false
  }
  return (
    getSingleText(existing.message) !== undefined && getSingleText(incoming.message) !== undefined
  )
}

const mergeQueuedFollowUp = (
  existing: QueuedTurnItem,
  incoming: QueuedTurnItem,
): QueuedTurnItem => {
  const existingText = getSingleText(existing.message)
  const incomingText = getSingleText(incoming.message)
  if (existingText === undefined || incomingText === undefined) return incoming

  return {
    ...existing,
    message: new Message({
      ...existing.message,
      parts: [new TextPart({ type: "text", text: `${existingText}\n${incomingText}` })],
    }),
  }
}

const appendFollowUpItem = (
  queue: ReadonlyArray<QueuedTurnItem>,
  item: QueuedTurnItem,
): QueuedTurnItem[] => {
  const last = queue[queue.length - 1]
  if (last === undefined || !canBatchQueuedFollowUp(last, item)) {
    return [...queue, item]
  }
  return [...queue.slice(0, -1), mergeQueuedFollowUp(last, item)]
}

const toQueueEntry = (
  tag: "steering" | "follow-up",
  item: QueuedTurnItem,
): QueueEntryInfo | undefined => {
  const content = messageText(item.message)
  if (content === "") return undefined
  const Entry = tag === "steering" ? SteeringQueueEntryInfo : FollowUpQueueEntryInfo
  return new Entry({
    id: item.message.id,
    content,
    createdAt: item.message.createdAt.getTime(),
    ...(item.agentOverride !== undefined ? { agentOverride: item.agentOverride } : {}),
  })
}

const toQueueSnapshot = (
  steeringItems: ReadonlyArray<QueuedTurnItem>,
  followUpItems: ReadonlyArray<QueuedTurnItem>,
): QueueSnapshot =>
  new QueueSnapshot({
    steering: steeringItems.flatMap((item) => {
      const entry = toQueueEntry("steering", item)
      return entry === undefined ? [] : [entry]
    }),
    followUp: followUpItems.flatMap((item) => {
      const entry = toQueueEntry("follow-up", item)
      return entry === undefined ? [] : [entry]
    }),
  })

export const emptyLoopQueueState = (): LoopQueueState => ({
  steering: [],
  followUp: [],
})

export const appendSteeringItem = (
  queue: LoopQueueState,
  item: QueuedTurnItem,
): LoopQueueState => ({
  ...queue,
  steering: [...queue.steering, item],
})

export const appendFollowUpQueueState = (
  queue: LoopQueueState,
  item: QueuedTurnItem,
): LoopQueueState => ({
  ...queue,
  followUp: appendFollowUpItem(queue.followUp, item),
})

export const clearQueueState = (_queue: LoopQueueState): LoopQueueState => emptyLoopQueueState()

const restampQueuedMessage = (message: Message): Message =>
  new Message({
    ...message,
    createdAt: new Date(),
  })

const restampQueuedTurnItem = (item: QueuedTurnItem): QueuedTurnItem => ({
  ...item,
  message: restampQueuedMessage(item.message),
})

export const takeNextQueuedTurn = (
  queue: LoopQueueState,
): { queue: LoopQueueState; nextItem?: QueuedTurnItem } => {
  const [nextSteer, ...restSteering] = queue.steering
  if (nextSteer !== undefined) {
    return {
      queue: { ...queue, steering: restSteering },
      nextItem: restampQueuedTurnItem(nextSteer),
    }
  }

  const [nextFollowUp, ...restFollowUp] = queue.followUp
  if (nextFollowUp === undefined) {
    return { queue }
  }

  return {
    queue: { ...queue, followUp: restFollowUp },
    nextItem: restampQueuedTurnItem(nextFollowUp),
  }
}

export const countQueuedFollowUps = (queue: LoopQueueState) => queue.followUp.length

// ── Shared field groups ──

const LoopStateBaseFields = {
  currentAgent: Schema.optional(AgentName),
}

const RunningTurnFields = {
  ...LoopStateBaseFields,
  message: Message,
  startedAtMs: Schema.Number,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

// ── Turn types (not persisted in machine state) ──

export const AssistantDraftSchema = Schema.Struct({
  text: Schema.String,
  reasoning: Schema.String,
  toolCalls: Schema.Array(ToolCallPart),
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
  tools?: ReadonlyArray<AnyCapabilityContribution>
  agent?: AgentDefinitionType
  driver?: DriverRef
  /** Origin of {@link driver} — set by `resolveAgentDriver` in the loop's
   *  `resolveTurnContext`. ACP-aware prompt slots read this
   *  to detect external dispatch and rewrite the prompt accordingly. */
  driverSource?: DriverSource
}

// ── 3-State Machine ──

export const AgentLoopState = State({
  /** No turn in progress. */
  Idle: LoopStateBaseFields,
  /** Agentic loop running: resolve → stream → tools → repeat. */
  Running: RunningTurnFields,
  /** Cold state: a tool requested human approval. No task fiber. */
  WaitingForInteraction: {
    ...RunningTurnFields,
    currentTurnAgent: AgentName,
    pendingRequestId: Schema.String,
    pendingToolCallId: Schema.String,
  },
})

export const AgentLoopEvent = Event({
  Start: { item: QueuedTurnItemSchema },
  TurnDone: {},
  TurnFailed: {},
  InteractionRequested: {
    pendingRequestId: Schema.String,
    pendingToolCallId: Schema.String,
    currentTurnAgent: AgentName,
  },
  InteractionResponded: { requestId: Schema.String },
  SwitchAgent: { agent: AgentName },
  Interrupt: {},
})

// ── Type aliases ──

export type LoopState = typeof AgentLoopState.Type
export type IdleState = Extract<LoopState, { _tag: "Idle" }>
export type RunningState = Extract<LoopState, { _tag: "Running" }>
export type WaitingForInteractionState = Extract<LoopState, { _tag: "WaitingForInteraction" }>
export type LoopActor = ActorRef<typeof AgentLoopState.Type, typeof AgentLoopEvent.Type>

// ── Runtime projection (transport/UI) ──
// Public runtime state mirrors the machine directly. No parallel `phase/status`
// matrix — the discriminator is the state.

export const LoopRuntimeStateSchema = TaggedEnumClass("LoopRuntimeState", {
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
export type LoopRuntimeState = Schema.Schema.Type<typeof LoopRuntimeStateSchema>

export const isLoopRuntimeIdle = (state: LoopRuntimeState): boolean => state._tag === "Idle"

// ── State builders ──

export const buildIdleState = (params?: { currentAgent?: AgentNameType }): IdleState =>
  AgentLoopState.Idle({
    currentAgent: params?.currentAgent,
  })

export const buildRunningState = (
  base: { currentAgent?: AgentNameType },
  item: QueuedTurnItem,
): RunningState =>
  AgentLoopState.Running({
    currentAgent: base.currentAgent,
    message: item.message,
    startedAtMs: Date.now(),
    agentOverride: item.agentOverride,
    runSpec: item.runSpec,
    interactive: item.interactive,
  })

export const toWaitingForInteractionState = (params: {
  state: RunningState
  currentTurnAgent: AgentNameType
  pendingRequestId: string
  pendingToolCallId: string
}): WaitingForInteractionState =>
  AgentLoopState.WaitingForInteraction.with(params.state, {
    currentTurnAgent: params.currentTurnAgent,
    pendingRequestId: params.pendingRequestId,
    pendingToolCallId: params.pendingToolCallId,
  })

export const updateCurrentAgentOnState = <S extends LoopState>(
  state: S,
  currentAgent: AgentNameType,
): S => AgentLoopState.with(state, { currentAgent })

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
): LoopRuntimeState => {
  const agent = state.currentAgent ?? DEFAULT_AGENT_NAME
  const queueSnapshot = queueSnapshotFromQueueState(queue)

  switch (state._tag) {
    case "Idle":
      return new LoopRuntimeStateSchema.Idle({ agent, queue: queueSnapshot })
    case "Running":
      return new LoopRuntimeStateSchema.Running({ agent, queue: queueSnapshot })
    case "WaitingForInteraction":
      return new LoopRuntimeStateSchema.WaitingForInteraction({ agent, queue: queueSnapshot })
  }
}
