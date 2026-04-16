import { Schema } from "effect"
import { type ActorRef, Event, State } from "effect-machine"
import type { AnyToolDefinition } from "../../domain/tool.js"
import {
  AgentName,
  RunSpecSchema,
  DEFAULT_AGENT_NAME,
  type AgentDefinition as AgentDefinitionType,
  type DriverRef,
  type AgentName as AgentNameType,
  type ReasoningEffort as ReasoningEffortType,
} from "../../domain/agent.js"
import { Message, TextPart, ToolCallPart, ToolResultPart } from "../../domain/message.js"
import type { ModelId as ModelIdType } from "../../domain/model.js"
import { QueueEntryInfo, type QueueSnapshot } from "../../domain/queue.js"
import { UsageSchema } from "../../domain/event.js"
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
  kind: "steering" | "follow-up",
  item: QueuedTurnItem,
): QueueEntryInfo | undefined => {
  const content = messageText(item.message)
  if (content === "") return undefined
  return new QueueEntryInfo({
    id: item.message.id,
    kind,
    content,
    createdAt: item.message.createdAt.getTime(),
    ...(item.agentOverride !== undefined ? { agentOverride: item.agentOverride } : {}),
  })
}

const toQueueSnapshot = (
  steeringItems: ReadonlyArray<QueuedTurnItem>,
  followUpItems: ReadonlyArray<QueuedTurnItem>,
): QueueSnapshot => ({
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
  queue: LoopQueueState,
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
  tools?: ReadonlyArray<AnyToolDefinition>
  agent?: AgentDefinitionType
  driver?: DriverRef
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
    draft: AssistantDraftSchema,
    completedToolResults: Schema.Array(ToolResultPart),
    pendingRequestId: Schema.String,
    pendingToolCallId: Schema.String,
  },
})

export const AgentLoopEvent = Event({
  Start: { item: QueuedTurnItemSchema },
  TurnDone: {},
  TurnFailed: {},
  InteractionRequested: {
    completedToolResults: Schema.Array(ToolResultPart),
    pendingRequestId: Schema.String,
    pendingToolCallId: Schema.String,
    currentTurnAgent: AgentName,
    draft: AssistantDraftSchema,
  },
  InteractionResponded: { requestId: Schema.String },
  QueueFollowUp: { item: QueuedTurnItemSchema, resumeIfIdle: Schema.Boolean },
  QueueSteering: { item: QueuedTurnItemSchema, urgent: Schema.Boolean },
  ClearQueue: {},
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
// Phases mirror the 3-state machine 1:1. Sub-phase tracking (resolving,
// executing-tools, finalizing) was declared but never emitted — collapsed
// into "running" until we have an honest sub-phase signal.

export type LoopRuntimePhase = "idle" | "running" | "waiting-for-interaction"
export type LoopRuntimeStatus = "idle" | "running" | "interrupted"
export type LoopRuntimeState = {
  phase: LoopRuntimePhase
  status: LoopRuntimeStatus
  agent: AgentNameType
  queue: QueueSnapshot
}

// ── State builders ──

export const buildIdleState = (params?: {
  queue?: LoopQueueState
  currentAgent?: AgentNameType
}): IdleState =>
  AgentLoopState.Idle({
    queue: params?.queue ?? emptyLoopQueueState(),
    currentAgent: params?.currentAgent,
  })

export const buildRunningState = (
  base: { queue: LoopQueueState; currentAgent?: AgentNameType },
  item: QueuedTurnItem,
): RunningState =>
  AgentLoopState.Running({
    queue: base.queue,
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
  draft: AssistantDraft
  completedToolResults: ReadonlyArray<typeof ToolResultPart.Type>
  pendingRequestId: string
  pendingToolCallId: string
}): WaitingForInteractionState =>
  AgentLoopState.WaitingForInteraction.with(params.state, {
    currentTurnAgent: params.currentTurnAgent,
    draft: params.draft,
    completedToolResults: [...params.completedToolResults],
    pendingRequestId: params.pendingRequestId,
    pendingToolCallId: params.pendingToolCallId,
  })

// ── Queue helpers on state ──

export const updateQueueOnState = <S extends LoopState>(state: S, queue: LoopQueueState): S =>
  AgentLoopState.with(state, { queue })

export const updateCurrentAgentOnState = <S extends LoopState>(
  state: S,
  currentAgent: AgentNameType,
): S => AgentLoopState.with(state, { currentAgent })

export const queueSnapshotFromState = (state: LoopState): QueueSnapshot =>
  toQueueSnapshot(state.queue.steering, state.queue.followUp)

export const queueContainsContent = (
  queue: ReadonlyArray<QueuedTurnItem>,
  content: string,
): boolean => queue.some((item) => messageText(item.message).includes(content))

// ── Runtime state projection ──

export const runtimeStateFromLoopState = (state: LoopState): LoopRuntimeState => {
  const agent = state.currentAgent ?? DEFAULT_AGENT_NAME
  const queue = queueSnapshotFromState(state)

  switch (state._tag) {
    case "Idle":
      return { phase: "idle", status: "idle", agent, queue }
    case "Running":
      return { phase: "running", status: "running", agent, queue }
    case "WaitingForInteraction":
      return { phase: "waiting-for-interaction", status: "running", agent, queue }
  }
}
