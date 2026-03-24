import { Schema } from "effect"
import { type ActorRef, Event, State } from "effect-machine"
import {
  AgentName,
  ReasoningEffort,
  type AgentName as AgentNameType,
  type ReasoningEffort as ReasoningEffortType,
} from "../../domain/agent.js"
import { Message, TextPart, ToolCallPart } from "../../domain/message.js"
import { ModelId } from "../../domain/model.js"
import type { ModelId as ModelIdType } from "../../domain/model.js"
import { QueueEntryInfo, type QueueSnapshot } from "../../domain/queue.js"
import { UsageSchema } from "../../domain/event.js"
import { messageText, getSingleText } from "./agent-loop.utils.js"

const QueuedTurnItemSchema = Schema.Struct({
  message: Message,
  bypass: Schema.Boolean,
  agentOverride: Schema.optional(AgentName),
})
export type QueuedTurnItem = typeof QueuedTurnItemSchema.Type

export const LoopQueueState = Schema.Struct({
  steering: Schema.Array(QueuedTurnItemSchema),
  followUp: Schema.Array(QueuedTurnItemSchema),
})
export type LoopQueueState = typeof LoopQueueState.Type

const canBatchQueuedFollowUp = (existing: QueuedTurnItem, incoming: QueuedTurnItem): boolean => {
  if (existing.agentOverride !== undefined || incoming.agentOverride !== undefined) return false
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
    bypass: item.bypass,
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

const LoopStateBaseFields = {
  queue: LoopQueueState,
  currentAgent: Schema.optional(AgentName),
  handoffSuppress: Schema.Number,
}

const ActiveTurnFields = {
  ...LoopStateBaseFields,
  message: Message,
  bypass: Schema.Boolean,
  startedAtMs: Schema.Number,
  agentOverride: Schema.optional(AgentName),
  turnInterrupted: Schema.Boolean,
  interruptAfterTools: Schema.Boolean,
}

export const ResolvedTurnFields = {
  currentTurnAgent: AgentName,
  messages: Schema.Array(Message),
  systemPrompt: Schema.String,
  modelId: ModelId,
  reasoning: Schema.optional(ReasoningEffort),
  temperature: Schema.optional(Schema.Number),
}

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
}

export const AgentLoopState = State({
  Idle: LoopStateBaseFields,
  Resolving: ActiveTurnFields,
  Streaming: {
    ...ActiveTurnFields,
    ...ResolvedTurnFields,
  },
  ExecutingTools: {
    ...ActiveTurnFields,
    currentTurnAgent: AgentName,
    draft: AssistantDraftSchema,
  },
  Finalizing: {
    ...ActiveTurnFields,
    currentTurnAgent: Schema.optional(AgentName),
    usage: Schema.optional(UsageSchema),
    streamFailed: Schema.Boolean,
  },
})

export const AgentLoopEvent = Event({
  Start: { item: QueuedTurnItemSchema },
  QueueFollowUp: { item: QueuedTurnItemSchema },
  QueueSteering: { item: QueuedTurnItemSchema, urgent: Schema.Boolean },
  Interrupt: {},
  SwitchAgent: { agent: AgentName },
  ClearQueue: {},
  Resolved: ResolvedTurnFields,
  StreamFinished: { currentTurnAgent: AgentName, draft: AssistantDraftSchema },
  StreamInterrupted: { currentTurnAgent: AgentName },
  StreamFailed: { currentTurnAgent: AgentName },
  ToolsFinished: {},
  FinalizeFinished: {
    queue: LoopQueueState,
    nextItem: Schema.optional(QueuedTurnItemSchema),
    handoffSuppress: Schema.Number,
  },
  PhaseFailed: {},
})

export type LoopState = typeof AgentLoopState.Type
export type IdleState = Extract<LoopState, { _tag: "Idle" }>
export type ResolvingState = Extract<LoopState, { _tag: "Resolving" }>
export type StreamingState = Extract<LoopState, { _tag: "Streaming" }>
export type ExecutingToolsState = Extract<LoopState, { _tag: "ExecutingTools" }>
export type FinalizingState = Extract<LoopState, { _tag: "Finalizing" }>
export type ActiveLoopState = Exclude<LoopState, IdleState>
export type LoopActor = ActorRef<typeof AgentLoopState.Type, typeof AgentLoopEvent.Type>
export type LoopRuntimePhase = "idle" | "resolving" | "streaming" | "executing-tools" | "finalizing"
export type LoopRuntimeStatus = "idle" | "running" | "interrupted"
export type LoopRuntimeState = {
  phase: LoopRuntimePhase
  status: LoopRuntimeStatus
  agent: AgentNameType
  queue: QueueSnapshot
}

export const buildIdleState = (params?: {
  queue?: LoopQueueState
  currentAgent?: AgentNameType
  handoffSuppress?: number
}): IdleState =>
  AgentLoopState.Idle({
    queue: params?.queue ?? emptyLoopQueueState(),
    currentAgent: params?.currentAgent,
    handoffSuppress: params?.handoffSuppress ?? 0,
  })

export const buildResolvingState = (
  base: {
    queue: LoopQueueState
    currentAgent?: AgentNameType
    handoffSuppress: number
  },
  item: QueuedTurnItem,
): ResolvingState =>
  AgentLoopState.Resolving({
    queue: base.queue,
    currentAgent: base.currentAgent,
    handoffSuppress: base.handoffSuppress,
    message: item.message,
    bypass: item.bypass,
    startedAtMs: Date.now(),
    agentOverride: item.agentOverride,
    turnInterrupted: false,
    interruptAfterTools: false,
  })

export function updateQueueOnState(state: IdleState, queue: LoopQueueState): IdleState
export function updateQueueOnState(state: ResolvingState, queue: LoopQueueState): ResolvingState
export function updateQueueOnState(state: StreamingState, queue: LoopQueueState): StreamingState
export function updateQueueOnState(
  state: ExecutingToolsState,
  queue: LoopQueueState,
): ExecutingToolsState
export function updateQueueOnState(state: FinalizingState, queue: LoopQueueState): FinalizingState
export function updateQueueOnState(state: LoopState, queue: LoopQueueState): LoopState
export function updateQueueOnState(state: LoopState, queue: LoopQueueState): LoopState {
  switch (state._tag) {
    case "Idle":
      return AgentLoopState.Idle.derive(state, { queue })
    case "Resolving":
      return AgentLoopState.Resolving.derive(state, { queue })
    case "Streaming":
      return AgentLoopState.Streaming.derive(state, { queue })
    case "ExecutingTools":
      return AgentLoopState.ExecutingTools.derive(state, { queue })
    case "Finalizing":
      return AgentLoopState.Finalizing.derive(state, { queue })
  }
}

export function updateCurrentAgentOnState(state: IdleState, currentAgent: AgentNameType): IdleState
export function updateCurrentAgentOnState(
  state: ResolvingState,
  currentAgent: AgentNameType,
): ResolvingState
export function updateCurrentAgentOnState(
  state: StreamingState,
  currentAgent: AgentNameType,
): StreamingState
export function updateCurrentAgentOnState(
  state: ExecutingToolsState,
  currentAgent: AgentNameType,
): ExecutingToolsState
export function updateCurrentAgentOnState(
  state: FinalizingState,
  currentAgent: AgentNameType,
): FinalizingState
export function updateCurrentAgentOnState(state: LoopState, currentAgent: AgentNameType): LoopState
export function updateCurrentAgentOnState(
  state: LoopState,
  currentAgent: AgentNameType,
): LoopState {
  switch (state._tag) {
    case "Idle":
      return AgentLoopState.Idle.derive(state, { currentAgent })
    case "Resolving":
      return AgentLoopState.Resolving.derive(state, { currentAgent })
    case "Streaming":
      return AgentLoopState.Streaming.derive(state, { currentAgent })
    case "ExecutingTools":
      return AgentLoopState.ExecutingTools.derive(state, { currentAgent })
    case "Finalizing":
      return AgentLoopState.Finalizing.derive(state, { currentAgent })
  }
}

export const markInterruptAfterTools = (state: ExecutingToolsState): ExecutingToolsState =>
  AgentLoopState.ExecutingTools.derive(state, { interruptAfterTools: true })

export function markTurnInterrupted(state: ResolvingState): ResolvingState
export function markTurnInterrupted(state: StreamingState): StreamingState
export function markTurnInterrupted(state: ExecutingToolsState): ExecutingToolsState
export function markTurnInterrupted(state: FinalizingState): FinalizingState
export function markTurnInterrupted(state: ActiveLoopState): ActiveLoopState
export function markTurnInterrupted(state: ActiveLoopState): ActiveLoopState {
  switch (state._tag) {
    case "Resolving":
      return AgentLoopState.Resolving.derive(state, { turnInterrupted: true })
    case "Streaming":
      return AgentLoopState.Streaming.derive(state, { turnInterrupted: true })
    case "ExecutingTools":
      return AgentLoopState.ExecutingTools.derive(state, { turnInterrupted: true })
    case "Finalizing":
      return AgentLoopState.Finalizing.derive(state, { turnInterrupted: true })
  }
}

export const toStreamingState = (params: {
  state: ResolvingState
  resolved: ResolvedTurn
}): StreamingState =>
  AgentLoopState.Streaming.derive(params.state, {
    currentTurnAgent: params.resolved.currentTurnAgent,
    messages: params.resolved.messages,
    systemPrompt: params.resolved.systemPrompt,
    modelId: params.resolved.modelId,
    ...(params.resolved.reasoning !== undefined ? { reasoning: params.resolved.reasoning } : {}),
    ...(params.resolved.temperature !== undefined
      ? { temperature: params.resolved.temperature }
      : {}),
  })

export const toExecutingToolsState = (params: {
  state: StreamingState
  currentTurnAgent: AgentNameType
  draft: AssistantDraft
}): ExecutingToolsState =>
  AgentLoopState.ExecutingTools.derive(params.state, {
    currentTurnAgent: params.currentTurnAgent,
    draft: params.draft,
  })

export const toFinalizingState = (params: {
  state: ResolvingState | StreamingState | ExecutingToolsState
  currentTurnAgent?: AgentNameType
  usage?: { inputTokens: number; outputTokens: number }
  streamFailed: boolean
  turnInterrupted: boolean
}): FinalizingState =>
  AgentLoopState.Finalizing.derive(params.state, {
    interruptAfterTools: false,
    turnInterrupted: params.turnInterrupted,
    currentTurnAgent: params.currentTurnAgent,
    usage: params.usage,
    streamFailed: params.streamFailed,
  })

export const queueSnapshotFromState = (state: LoopState): QueueSnapshot =>
  toQueueSnapshot(state.queue.steering, state.queue.followUp)

export const queueContainsContent = (
  queue: ReadonlyArray<QueuedTurnItem>,
  content: string,
): boolean => queue.some((item) => messageText(item.message).includes(content))

export const runtimeStateFromLoopState = (state: LoopState): LoopRuntimeState => {
  const agent = state.currentAgent ?? "cowork"
  const queue = queueSnapshotFromState(state)

  switch (state._tag) {
    case "Idle":
      return { phase: "idle", status: "idle", agent, queue }
    case "Resolving":
      return {
        phase: "resolving",
        status: state.turnInterrupted ? "interrupted" : "running",
        agent,
        queue,
      }
    case "Streaming":
      return {
        phase: "streaming",
        status: state.turnInterrupted ? "interrupted" : "running",
        agent,
        queue,
      }
    case "ExecutingTools":
      return {
        phase: "executing-tools",
        status: state.turnInterrupted || state.interruptAfterTools ? "interrupted" : "running",
        agent,
        queue,
      }
    case "Finalizing":
      return {
        phase: "finalizing",
        status: state.turnInterrupted ? "interrupted" : "running",
        agent,
        queue,
      }
  }
}
