import { Schema } from "effect"
import { type ActorRef, Event, State } from "effect-machine"
import type { AnyToolDefinition } from "../../domain/tool.js"
import {
  AgentName,
  ReasoningEffort,
  type AgentName as AgentNameType,
  type ReasoningEffort as ReasoningEffortType,
} from "../../domain/agent.js"
import { Message, TextPart, ToolCallPart, ToolResultPart } from "../../domain/message.js"
import { ModelId } from "../../domain/model.js"
import type { ModelId as ModelIdType } from "../../domain/model.js"
import { QueueEntryInfo, type QueueSnapshot } from "../../domain/queue.js"
import { UsageSchema } from "../../domain/event.js"
import { messageText, getSingleText } from "./agent-loop.utils.js"

const QueuedTurnItemSchema = Schema.Struct({
  message: Message,
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
}

const ActiveTurnFields = {
  ...LoopStateBaseFields,
  message: Message,
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
  /** Active tools for this turn — resolved per-agent, not serialized into machine state.
   *  Absent in state machine transitions (tools live in a side-channel Ref). */
  tools?: ReadonlyArray<AnyToolDefinition>
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
  WaitingForInteraction: {
    ...ActiveTurnFields,
    currentTurnAgent: AgentName,
    draft: AssistantDraftSchema,
    /** Completed tool results from tools that ran before the interaction */
    completedToolResults: Schema.Array(ToolResultPart),
    /** requestId of the pending interaction in InteractionStorage */
    pendingRequestId: Schema.String,
    /** Which tool call triggered the interaction */
    pendingToolCallId: Schema.String,
    /** Interaction type for recovery dispatch */
    interactionType: Schema.Literals(["prompt", "handoff", "ask-user"]),
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
  InteractionRequested: {
    completedToolResults: Schema.Array(ToolResultPart),
    pendingRequestId: Schema.String,
    pendingToolCallId: Schema.String,
    interactionType: Schema.Literals(["prompt", "handoff", "ask-user"]),
  },
  InteractionResponded: {
    requestId: Schema.String,
  },
  FinalizeFinished: {
    queue: LoopQueueState,
    nextItem: Schema.optional(QueuedTurnItemSchema),
  },
  PhaseFailed: {},
})

export type LoopState = typeof AgentLoopState.Type
export type IdleState = Extract<LoopState, { _tag: "Idle" }>
export type ResolvingState = Extract<LoopState, { _tag: "Resolving" }>
export type StreamingState = Extract<LoopState, { _tag: "Streaming" }>
export type ExecutingToolsState = Extract<LoopState, { _tag: "ExecutingTools" }>
export type WaitingForInteractionState = Extract<LoopState, { _tag: "WaitingForInteraction" }>
export type FinalizingState = Extract<LoopState, { _tag: "Finalizing" }>
export type ActiveLoopState = Exclude<LoopState, IdleState>
export type LoopActor = ActorRef<typeof AgentLoopState.Type, typeof AgentLoopEvent.Type>
export type LoopRuntimePhase =
  | "idle"
  | "resolving"
  | "streaming"
  | "executing-tools"
  | "waiting-for-interaction"
  | "finalizing"
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
}): IdleState =>
  AgentLoopState.Idle({
    queue: params?.queue ?? emptyLoopQueueState(),
    currentAgent: params?.currentAgent,
  })

export const buildResolvingState = (
  base: {
    queue: LoopQueueState
    currentAgent?: AgentNameType
  },
  item: QueuedTurnItem,
): ResolvingState =>
  AgentLoopState.Resolving({
    queue: base.queue,
    currentAgent: base.currentAgent,
    message: item.message,
    startedAtMs: Date.now(),
    agentOverride: item.agentOverride,
    turnInterrupted: false,
    interruptAfterTools: false,
  })

export const updateQueueOnState = <S extends LoopState>(state: S, queue: LoopQueueState): S =>
  AgentLoopState.derive(state, { queue } as Partial<Omit<S, "_tag">>)

export const updateCurrentAgentOnState = <S extends LoopState>(
  state: S,
  currentAgent: AgentNameType,
): S => AgentLoopState.derive(state, { currentAgent } as Partial<Omit<S, "_tag">>)

export const markInterruptAfterTools = (state: ExecutingToolsState): ExecutingToolsState =>
  AgentLoopState.derive(state, { interruptAfterTools: true })

export const markTurnInterrupted = <S extends ActiveLoopState>(state: S): S =>
  AgentLoopState.derive(state, { turnInterrupted: true } as Partial<Omit<S, "_tag">>)

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

export const toWaitingForInteractionState = (params: {
  state: ExecutingToolsState
  completedToolResults: ReadonlyArray<typeof ToolResultPart.Type>
  pendingRequestId: string
  pendingToolCallId: string
  interactionType: "prompt" | "handoff" | "ask-user"
}): WaitingForInteractionState =>
  AgentLoopState.WaitingForInteraction.derive(params.state, {
    completedToolResults: [...params.completedToolResults],
    pendingRequestId: params.pendingRequestId,
    pendingToolCallId: params.pendingToolCallId,
    interactionType: params.interactionType,
  })

export const toFinalizingState = (params: {
  state: ResolvingState | StreamingState | ExecutingToolsState | WaitingForInteractionState
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

/** Re-enter Resolving from ExecutingTools for tool-result continuation.
 *  Preserves the original turn's startedAtMs and message. */
export const buildContinuationResolvingState = (state: ExecutingToolsState): ResolvingState =>
  AgentLoopState.Resolving.derive(state, {
    agentOverride: state.agentOverride,
    turnInterrupted: false,
    interruptAfterTools: false,
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
    case "WaitingForInteraction":
      return {
        phase: "waiting-for-interaction",
        status: state.turnInterrupted ? "interrupted" : "running",
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
