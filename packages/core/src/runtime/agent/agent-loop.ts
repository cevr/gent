import { Cause, ServiceMap, Deferred, Effect, Layer, Ref, Schema, Semaphore, Stream } from "effect"
import {
  type ActorRef,
  type AnyInspectionEvent,
  combineInspectors,
  Event,
  InspectorService,
  Machine,
  State,
  makeInspectorEffect,
  tracingInspector,
} from "effect-machine"
import {
  AgentDefinition,
  AgentName,
  ReasoningEffort,
  resolveAgentModel,
  SubagentError,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { ModelId } from "../../domain/model.js"
import { QueueEntryInfo, type QueueSnapshot } from "../../domain/queue.js"
import {
  EventStore,
  AgentSwitched,
  StreamStarted,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
  MessageReceived,
  ErrorOccurred,
  ProviderRetrying,
  MachineInspected,
  MachineTaskFailed,
  MachineTaskSucceeded,
  UsageSchema,
  type AgentEvent,
} from "../../domain/event.js"
import { Message, TextPart, ReasoningPart, ToolCallPart } from "../../domain/message.js"
import { SessionId, BranchId, type MessageId } from "../../domain/ids.js"
import { type ToolAction, type ToolContext } from "../../domain/tool.js"
import { HandoffHandler } from "../../domain/interaction-handlers.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Storage, type StorageService } from "../../storage/sqlite-storage.js"
import { Provider, type FinishChunk } from "../../providers/provider.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { withRetry } from "../retry"
import { ExtensionRegistry } from "../extensions/registry.js"
import { ToolRunner } from "./tool-runner"
import {
  type ActiveStreamHandle,
  type AssistantDraft,
  type ResolvedTurn,
  executeToolsPhase,
  finalizeTurnPhase,
  resolveTurnPhase,
  streamTurnPhase,
} from "./agent-loop-phases.js"

// Agent Loop Error

const buildSystemPrompt = (basePrompt: string, agent: AgentDefinition): string => {
  const parts: string[] = [basePrompt]

  if (agent.systemPromptAddendum !== undefined && agent.systemPromptAddendum !== "") {
    parts.push(`\n\n## Agent: ${agent.name}\n${agent.systemPromptAddendum}`)
  }

  return parts.join("")
}

const VALID_REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

const resolveReasoning = (
  agent: AgentDefinition,
  sessionOverride?: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined => {
  if (sessionOverride !== undefined && VALID_REASONING_LEVELS.has(sessionOverride)) {
    return sessionOverride as "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  }
  return agent.reasoningEffort
}

export class AgentLoopError extends Schema.TaggedErrorClass<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// Steer Command

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

export const SteerCommand = Schema.Union([
  Schema.TaggedStruct("Cancel", SteerTargetFields),
  Schema.TaggedStruct("Interrupt", SteerTargetFields),
  Schema.TaggedStruct("Interject", {
    ...SteerTargetFields,
    message: Schema.String,
    agent: Schema.optional(AgentName),
  }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerCommand = typeof SteerCommand.Type

// Agent Loop Context

const QueuedTurnItem = Schema.Struct({
  message: Message,
  bypass: Schema.Boolean,
  agentOverride: Schema.optional(AgentName),
})
type QueuedTurnItem = typeof QueuedTurnItem.Type

const LoopQueueState = Schema.Struct({
  steering: Schema.Array(QueuedTurnItem),
  followUp: Schema.Array(QueuedTurnItem),
})
type LoopQueueState = typeof LoopQueueState.Type

const getSingleText = (message: Message): string | undefined => {
  if (message.parts.length !== 1) return undefined
  const [part] = message.parts
  return part?.type === "text" ? part.text : undefined
}

const canBatchQueuedFollowUp = (existing: QueuedTurnItem, incoming: QueuedTurnItem): boolean => {
  if (existing.agentOverride !== undefined || incoming.agentOverride !== undefined) return false
  if (existing.message.role !== "user" || incoming.message.role !== "user") return false
  if (existing.message.kind === "interjection" || incoming.message.kind === "interjection")
    return false
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

const restampQueuedMessage = (message: Message): Message =>
  new Message({
    ...message,
    createdAt: new Date(),
  })

const messageText = (message: Message): string =>
  message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

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

const emptyLoopQueueState = (): LoopQueueState => ({
  steering: [],
  followUp: [],
})

const appendSteeringItem = (queue: LoopQueueState, item: QueuedTurnItem): LoopQueueState => ({
  ...queue,
  steering: [...queue.steering, item],
})

const appendFollowUpQueueState = (queue: LoopQueueState, item: QueuedTurnItem): LoopQueueState => ({
  ...queue,
  followUp: appendFollowUpItem(queue.followUp, item),
})

const clearQueueState = (_queue: LoopQueueState): LoopQueueState => emptyLoopQueueState()

const restampQueuedTurnItem = (item: QueuedTurnItem): QueuedTurnItem => ({
  ...item,
  message: restampQueuedMessage(item.message),
})

const takeNextQueuedTurn = (
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

const countQueuedFollowUps = (queue: LoopQueueState) => queue.followUp.length

const resolveStoredAgent = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<AgentNameType, never> =>
  Effect.gen(function* () {
    const latestAgentEvent = yield* params.storage
      .getLatestEvent({
        sessionId: params.sessionId,
        branchId: params.branchId,
        tags: ["AgentSwitched"],
      })
      .pipe(Effect.catchEager(() => Effect.succeed(undefined)))

    const raw =
      latestAgentEvent !== undefined && latestAgentEvent._tag === "AgentSwitched"
        ? latestAgentEvent.toAgent
        : undefined

    return Schema.is(AgentName)(raw) ? raw : "cowork"
  })

const applyAgentOverrides = (agent: AgentDefinition, input: AgentRunInput): AgentDefinition => {
  if (
    input.overrideAllowedActions === undefined &&
    input.overrideAllowedTools === undefined &&
    input.overrideDeniedTools === undefined &&
    input.overrideReasoningEffort === undefined &&
    input.overrideSystemPromptAddendum === undefined
  ) {
    return agent
  }

  return new AgentDefinition({
    ...agent,
    ...(input.overrideAllowedActions !== undefined
      ? {
          allowedActions: input.overrideAllowedActions as ReadonlyArray<ToolAction>,
        }
      : {}),
    ...(input.overrideAllowedTools !== undefined
      ? { allowedTools: input.overrideAllowedTools }
      : {}),
    ...(input.overrideDeniedTools !== undefined ? { deniedTools: input.overrideDeniedTools } : {}),
    ...(input.overrideReasoningEffort !== undefined
      ? { reasoningEffort: input.overrideReasoningEffort }
      : {}),
    ...(input.overrideSystemPromptAddendum !== undefined
      ? {
          systemPromptAddendum:
            agent.systemPromptAddendum !== undefined
              ? `${agent.systemPromptAddendum}\n\n${input.overrideSystemPromptAddendum}`
              : input.overrideSystemPromptAddendum,
        }
      : {}),
  })
}

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

const ResolvedTurnFields = {
  currentTurnAgent: AgentName,
  messages: Schema.Array(Message),
  systemPrompt: Schema.String,
  modelId: ModelId,
  reasoning: Schema.optional(ReasoningEffort),
  temperature: Schema.optional(Schema.Number),
}

const AssistantDraftSchema = Schema.Struct({
  text: Schema.String,
  reasoning: Schema.String,
  toolCalls: Schema.Array(ToolCallPart),
  usage: Schema.optional(UsageSchema),
})

// Agent Loop Machine

const AgentLoopState = State({
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

const AgentLoopEvent = Event({
  Start: { item: QueuedTurnItem },
  QueueFollowUp: { item: QueuedTurnItem },
  QueueSteering: { item: QueuedTurnItem, urgent: Schema.Boolean },
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
    nextItem: Schema.optional(QueuedTurnItem),
    handoffSuppress: Schema.Number,
  },
  PhaseFailed: {},
})

type LoopState = typeof AgentLoopState.Type
type IdleState = Extract<LoopState, { _tag: "Idle" }>
type ResolvingState = Extract<LoopState, { _tag: "Resolving" }>
type StreamingState = Extract<LoopState, { _tag: "Streaming" }>
type ExecutingToolsState = Extract<LoopState, { _tag: "ExecutingTools" }>
type FinalizingState = Extract<LoopState, { _tag: "Finalizing" }>
type ActiveLoopState = Exclude<LoopState, IdleState>

type LoopActor = ActorRef<typeof AgentLoopState.Type, typeof AgentLoopEvent.Type>

type SemaphoreType = Semaphore.Semaphore

type LoopHandle = {
  actor: LoopActor
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  bashSemaphore: SemaphoreType
}

const buildIdleState = (params?: {
  queue?: LoopQueueState
  currentAgent?: AgentNameType
  handoffSuppress?: number
}): IdleState =>
  AgentLoopState.Idle({
    queue: params?.queue ?? emptyLoopQueueState(),
    currentAgent: params?.currentAgent,
    handoffSuppress: params?.handoffSuppress ?? 0,
  })

const buildResolvingState = (
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

function updateQueueOnState(state: IdleState, queue: LoopQueueState): IdleState
function updateQueueOnState(state: ResolvingState, queue: LoopQueueState): ResolvingState
function updateQueueOnState(state: StreamingState, queue: LoopQueueState): StreamingState
function updateQueueOnState(state: ExecutingToolsState, queue: LoopQueueState): ExecutingToolsState
function updateQueueOnState(state: FinalizingState, queue: LoopQueueState): FinalizingState
function updateQueueOnState(state: LoopState, queue: LoopQueueState): LoopState
function updateQueueOnState(state: LoopState, queue: LoopQueueState): LoopState {
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

function updateCurrentAgentOnState(state: IdleState, currentAgent: AgentNameType): IdleState
function updateCurrentAgentOnState(
  state: ResolvingState,
  currentAgent: AgentNameType,
): ResolvingState
function updateCurrentAgentOnState(
  state: StreamingState,
  currentAgent: AgentNameType,
): StreamingState
function updateCurrentAgentOnState(
  state: ExecutingToolsState,
  currentAgent: AgentNameType,
): ExecutingToolsState
function updateCurrentAgentOnState(
  state: FinalizingState,
  currentAgent: AgentNameType,
): FinalizingState
function updateCurrentAgentOnState(state: LoopState, currentAgent: AgentNameType): LoopState
function updateCurrentAgentOnState(state: LoopState, currentAgent: AgentNameType): LoopState {
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

const markInterruptAfterTools = (state: ExecutingToolsState): ExecutingToolsState =>
  AgentLoopState.ExecutingTools.derive(state, { interruptAfterTools: true })

function markTurnInterrupted(state: ResolvingState): ResolvingState
function markTurnInterrupted(state: StreamingState): StreamingState
function markTurnInterrupted(state: ExecutingToolsState): ExecutingToolsState
function markTurnInterrupted(state: FinalizingState): FinalizingState
function markTurnInterrupted(state: ActiveLoopState): ActiveLoopState
function markTurnInterrupted(state: ActiveLoopState): ActiveLoopState {
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

const toStreamingState = (params: {
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

const toExecutingToolsState = (params: {
  state: StreamingState
  currentTurnAgent: AgentNameType
  draft: AssistantDraft
}): ExecutingToolsState =>
  AgentLoopState.ExecutingTools.derive(params.state, {
    currentTurnAgent: params.currentTurnAgent,
    draft: params.draft,
  })

const toFinalizingState = (params: {
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

const queueSnapshotFromState = (state: LoopState): QueueSnapshot =>
  toQueueSnapshot(state.queue.steering, state.queue.followUp)

const queueContainsContent = (queue: ReadonlyArray<QueuedTurnItem>, content: string): boolean =>
  queue.some((item) => messageText(item.message).includes(content))

const interruptActiveStream = (activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>) =>
  Effect.gen(function* () {
    const activeStream = yield* Ref.get(activeStreamRef)
    if (activeStream === undefined) return
    yield* Ref.set(activeStream.interruptedRef, true)
    yield* Deferred.succeed(activeStream.interruptDeferred, undefined).pipe(Effect.ignore)
    activeStream.abortController.abort()
  })

const publishPhaseFailure = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  cause: Cause.Cause<unknown>
}) =>
  params
    .publishEvent(
      new ErrorOccurred({
        sessionId: params.sessionId,
        branchId: params.branchId,
        error: Cause.pretty(params.cause),
      }),
    )
    .pipe(
      Effect.catchEager((error) => Effect.logWarning("failed to publish ErrorOccurred", error)),
      Effect.asVoid,
    )

const makePublishingInspector = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, unknown>
  sessionId: SessionId
  branchId: BranchId
}) =>
  combineInspectors(
    tracingInspector<{ readonly _tag: string }, { readonly _tag: string }>({
      attributes: () => ({
        sessionId: params.sessionId,
        branchId: params.branchId,
      }),
    }),
    makeInspectorEffect<{ readonly _tag: string }, { readonly _tag: string }>(
      (event: AnyInspectionEvent) =>
        params
          .publishEvent(
            new MachineInspected({
              sessionId: params.sessionId,
              branchId: params.branchId,
              actorId: event.actorId,
              inspectionType: event.type,
              payload: event,
            }),
          )
          .pipe(
            Effect.withSpan("Machine.inspect.publish"),
            Effect.catchEager((error) =>
              Effect.logWarning("failed to publish MachineInspected", error),
            ),
          ),
    ),
  )

// Agent Loop Service

export interface AgentLoopService {
  readonly run: (
    message: Message,
    options?: { bypass?: boolean },
  ) => Effect.Effect<void, AgentLoopError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void>
  readonly followUp: (message: Message) => Effect.Effect<void, AgentLoopError>
  readonly drainQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot>
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot>
  readonly isRunning: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<boolean>
}

export class AgentLoop extends ServiceMap.Service<AgentLoop, AgentLoopService>()(
  "@gent/runtime/src/agent/agent-loop/AgentLoop",
) {
  static Live = (config: {
    systemPrompt: string
  }): Layer.Layer<
    AgentLoop,
    never,
    Storage | Provider | ExtensionRegistry | EventStore | HandoffHandler | ToolRunner
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const provider = yield* Provider
        const extensionRegistry = yield* ExtensionRegistry
        const eventStore = yield* EventStore
        const handoffHandler = yield* HandoffHandler
        const toolRunner = yield* ToolRunner
        const loopsRef = yield* Ref.make<Map<string, LoopHandle>>(new Map())

        const stateKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`
        const publishEvent = (event: AgentEvent) =>
          eventStore.publish(event).pipe(
            Effect.mapError(
              (error) =>
                new AgentLoopError({
                  message: `Failed to publish ${event._tag}`,
                  cause: error,
                }),
            ),
          )

        const makeLoop = (sessionId: SessionId, branchId: BranchId) =>
          Effect.gen(function* () {
            const bashSemaphore = yield* Semaphore.make(1)
            const activeStreamRef = yield* Ref.make<ActiveStreamHandle | undefined>(undefined)
            const currentAgent = yield* resolveStoredAgent({ storage, sessionId, branchId })
            const inspector = makePublishingInspector({
              publishEvent,
              sessionId,
              branchId,
            })

            function switchAgentOnState(
              state: IdleState,
              next: AgentNameType,
            ): Effect.Effect<IdleState>
            function switchAgentOnState(
              state: ResolvingState,
              next: AgentNameType,
            ): Effect.Effect<ResolvingState>
            function switchAgentOnState(
              state: StreamingState,
              next: AgentNameType,
            ): Effect.Effect<StreamingState>
            function switchAgentOnState(
              state: ExecutingToolsState,
              next: AgentNameType,
            ): Effect.Effect<ExecutingToolsState>
            function switchAgentOnState(
              state: FinalizingState,
              next: AgentNameType,
            ): Effect.Effect<FinalizingState>
            function switchAgentOnState(
              state: LoopState,
              next: AgentNameType,
            ): Effect.Effect<LoopState>
            function switchAgentOnState(state: LoopState, next: AgentNameType) {
              return Effect.gen(function* () {
                const previous = state.currentAgent ?? "cowork"
                if (previous === next) return state
                const resolved = yield* extensionRegistry.getAgent(next)
                if (resolved === undefined) return state

                yield* publishEvent(
                  new AgentSwitched({
                    sessionId,
                    branchId,
                    fromAgent: previous,
                    toAgent: next,
                  }),
                ).pipe(
                  Effect.catchEager((error) =>
                    Effect.logWarning("failed to publish AgentSwitched", error),
                  ),
                )

                return updateCurrentAgentOnState(state, next)
              }).pipe(Effect.orDie)
            }

            const runResolvingState = Effect.fn("AgentLoop.runResolvingState")(function* (
              state: ResolvingState,
            ) {
              const resolved = yield* resolveTurnPhase({
                message: state.message,
                agentOverride: state.agentOverride,
                currentAgent: state.currentAgent,
                storage,
                branchId,
                extensionRegistry,
                sessionId,
                publishEvent,
                systemPrompt: config.systemPrompt,
              })
              if (resolved === undefined) {
                return AgentLoopEvent.PhaseFailed
              }

              return AgentLoopEvent.Resolved(resolved)
            })

            const runStreamingState = Effect.fn("AgentLoop.runStreamingState")(function* (
              state: StreamingState,
            ) {
              const activeStream: ActiveStreamHandle = {
                abortController: new AbortController(),
                interruptDeferred: yield* Deferred.make<void>(),
                interruptedRef: yield* Ref.make(false),
              }

              yield* Ref.set(activeStreamRef, activeStream)
              const collected = yield* streamTurnPhase({
                resolved: {
                  currentTurnAgent: state.currentTurnAgent,
                  messages: state.messages,
                  systemPrompt: state.systemPrompt,
                  modelId: state.modelId,
                  ...(state.reasoning !== undefined ? { reasoning: state.reasoning } : {}),
                  ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
                },
                provider,
                extensionRegistry,
                publishEvent,
                storage,
                sessionId,
                branchId,
                activeStream,
              }).pipe(Effect.ensuring(Ref.set(activeStreamRef, undefined)))

              if (collected.interrupted) {
                return AgentLoopEvent.StreamInterrupted({
                  currentTurnAgent: state.currentTurnAgent,
                })
              }

              if (collected.streamFailed) {
                return AgentLoopEvent.StreamFailed({
                  currentTurnAgent: state.currentTurnAgent,
                })
              }

              return AgentLoopEvent.StreamFinished({
                currentTurnAgent: state.currentTurnAgent,
                draft: collected.draft,
              })
            })

            const runExecutingToolsState = Effect.fn("AgentLoop.runExecutingToolsState")(function* (
              state: ExecutingToolsState,
            ) {
              yield* executeToolsPhase({
                draft: state.draft,
                publishEvent,
                sessionId,
                branchId,
                currentTurnAgent: state.currentTurnAgent,
                bypass: state.bypass,
                toolRunner,
                extensionRegistry,
                bashSemaphore,
                storage,
              })
              return AgentLoopEvent.ToolsFinished
            })

            const runFinalizingState = Effect.fn("AgentLoop.runFinalizingState")(function* (
              state: FinalizingState,
            ) {
              const nextHandoffSuppress = yield* finalizeTurnPhase({
                storage,
                publishEvent,
                sessionId,
                branchId,
                startedAtMs: state.startedAtMs,
                messageId: state.message.id,
                turnInterrupted: state.turnInterrupted,
                handoffSuppress: state.handoffSuppress,
                currentAgent: state.currentAgent ?? state.currentTurnAgent ?? "cowork",
                extensionRegistry,
                handoffHandler,
              })

              const { queue, nextItem } = takeNextQueuedTurn(state.queue)
              return AgentLoopEvent.FinalizeFinished({
                queue,
                nextItem,
                handoffSuppress: nextHandoffSuppress,
              })
            })

            const loopMachine = Machine.make({
              state: AgentLoopState,
              event: AgentLoopEvent,
              initial: buildIdleState({ currentAgent }),
            })
              .on(AgentLoopState.Idle, AgentLoopEvent.Start, ({ state, event }) =>
                buildResolvingState(state, event.item),
              )
              .on(
                [
                  AgentLoopState.Idle,
                  AgentLoopState.Resolving,
                  AgentLoopState.Streaming,
                  AgentLoopState.ExecutingTools,
                  AgentLoopState.Finalizing,
                ],
                AgentLoopEvent.QueueFollowUp,
                ({ state, event }) =>
                  updateQueueOnState(state, appendFollowUpQueueState(state.queue, event.item)),
              )
              .on(
                [
                  AgentLoopState.Idle,
                  AgentLoopState.Resolving,
                  AgentLoopState.Streaming,
                  AgentLoopState.ExecutingTools,
                  AgentLoopState.Finalizing,
                ],
                AgentLoopEvent.ClearQueue,
                ({ state }) => updateQueueOnState(state, clearQueueState(state.queue)),
              )
              .on(
                [
                  AgentLoopState.Idle,
                  AgentLoopState.Resolving,
                  AgentLoopState.Streaming,
                  AgentLoopState.ExecutingTools,
                  AgentLoopState.Finalizing,
                ],
                AgentLoopEvent.SwitchAgent,
                ({ state, event }) => switchAgentOnState(state, event.agent),
              )
              .on(AgentLoopState.Idle, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.Idle, AgentLoopEvent.Interrupt, ({ state }) => state)
              .on(AgentLoopState.Resolving, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.Resolving, AgentLoopEvent.Interrupt, ({ state }) =>
                markTurnInterrupted(state),
              )
              .on(AgentLoopState.Resolving, AgentLoopEvent.Resolved, ({ state, event }) =>
                toStreamingState({ state, resolved: event }),
              )
              .on(AgentLoopState.Resolving, AgentLoopEvent.PhaseFailed, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.agentOverride ?? state.currentAgent ?? "cowork",
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted,
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                Effect.gen(function* () {
                  if (event.urgent) {
                    yield* interruptActiveStream(activeStreamRef)
                  }
                  return updateQueueOnState(state, appendSteeringItem(state.queue, event.item))
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.Interrupt, ({ state }) =>
                interruptActiveStream(activeStreamRef).pipe(Effect.as(state)),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.StreamFinished, ({ state, event }) =>
                event.draft.toolCalls.length === 0
                  ? toFinalizingState({
                      state,
                      currentTurnAgent: event.currentTurnAgent,
                      usage: event.draft.usage,
                      streamFailed: false,
                      turnInterrupted: state.turnInterrupted,
                    })
                  : toExecutingToolsState({
                      state,
                      currentTurnAgent: event.currentTurnAgent,
                      draft: event.draft,
                    }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.StreamInterrupted, ({ state, event }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: event.currentTurnAgent,
                  streamFailed: false,
                  turnInterrupted: true,
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.StreamFailed, ({ state, event }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: event.currentTurnAgent,
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted,
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.PhaseFailed, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted,
                }),
              )
              .on(
                AgentLoopState.ExecutingTools,
                AgentLoopEvent.QueueSteering,
                ({ state, event }) => {
                  const nextState = updateQueueOnState(
                    state,
                    appendSteeringItem(state.queue, event.item),
                  ) as ExecutingToolsState
                  return event.urgent ? markInterruptAfterTools(nextState) : nextState
                },
              )
              .on(AgentLoopState.ExecutingTools, AgentLoopEvent.Interrupt, ({ state }) =>
                markInterruptAfterTools(state),
              )
              .on(AgentLoopState.ExecutingTools, AgentLoopEvent.ToolsFinished, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  usage: state.draft.usage,
                  streamFailed: false,
                  turnInterrupted: state.turnInterrupted || state.interruptAfterTools,
                }),
              )
              .on(AgentLoopState.ExecutingTools, AgentLoopEvent.PhaseFailed, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  usage: state.draft.usage,
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted || state.interruptAfterTools,
                }),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.Interrupt, ({ state }) =>
                markTurnInterrupted(state),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.FinalizeFinished, ({ state, event }) =>
                event.nextItem !== undefined
                  ? buildResolvingState(
                      {
                        queue: event.queue,
                        currentAgent: state.currentAgent,
                        handoffSuppress: event.handoffSuppress,
                      },
                      event.nextItem,
                    )
                  : buildIdleState({
                      queue: event.queue,
                      currentAgent: state.currentAgent,
                      handoffSuppress: event.handoffSuppress,
                    }),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.PhaseFailed, ({ state }) =>
                buildIdleState({
                  queue: state.queue,
                  currentAgent: state.currentAgent,
                  handoffSuppress: state.handoffSuppress,
                }),
              )
              .task(
                AgentLoopState.Resolving,
                ({ state }) =>
                  runResolvingState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.resolve"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "resolve",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .task(
                AgentLoopState.Streaming,
                ({ state }) =>
                  runStreamingState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.stream"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "stream",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .task(
                AgentLoopState.ExecutingTools,
                ({ state }) =>
                  runExecutingToolsState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.tools"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "tools",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .task(
                AgentLoopState.Finalizing,
                ({ state }) =>
                  runFinalizingState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.finalize"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "finalize",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .build()

            const loopActor = yield* Machine.spawn(
              loopMachine,
              `agent-loop:${sessionId}:${branchId}`,
            ).pipe(Effect.provideService(InspectorService, inspector))

            return {
              actor: loopActor,
              activeStreamRef,
              bashSemaphore,
            }
          })

        const getLoop = Effect.fn("AgentLoop.getLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const existing = (yield* Ref.get(loopsRef)).get(key)
          if (existing !== undefined) return existing
          const created = yield* makeLoop(sessionId, branchId)
          yield* Ref.update(loopsRef, (loops) => {
            const next = new Map(loops)
            next.set(key, created)
            return next
          })
          return created
        })

        const findLoop = Effect.fn("AgentLoop.findLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const loops = yield* Ref.get(loopsRef)
          return loops.get(key)
        })

        const service: AgentLoopService = {
          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: { bypass?: boolean },
          ) {
            const bypass = options?.bypass ?? true
            const loop = yield* getLoop(message.sessionId, message.branchId)
            const initialState = yield* loop.actor.snapshot
            const item: QueuedTurnItem = { message, bypass }

            if (initialState._tag !== "Idle") {
              const content = messageText(message)
              yield* loop.actor.sendAndWait(AgentLoopEvent.QueueFollowUp({ item }), (state) =>
                queueContainsContent(state.queue.followUp, content),
              )
              return
            }

            yield* loop.actor.send(AgentLoopEvent.Start({ item }))
            yield* loop.actor.waitFor((state) => state._tag === "Idle" && state !== initialState)
          }),

          steer: (command) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(command.sessionId, command.branchId)
              const loopState = yield* loop.actor.snapshot

              switch (command._tag) {
                case "SwitchAgent":
                  yield* loop.actor.send(AgentLoopEvent.SwitchAgent({ agent: command.agent }))
                  return
                case "Cancel":
                case "Interrupt":
                  if (loopState._tag === "Streaming" || loopState._tag === "ExecutingTools") {
                    yield* loop.actor.send(AgentLoopEvent.Interrupt)
                  }
                  return
                case "Interject": {
                  const session = yield* storage
                    .getSession(command.sessionId)
                    .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
                  const bypass = session?.bypass ?? true
                  const interjectMessage = new Message({
                    id: Bun.randomUUIDv7() as MessageId,
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    kind: "interjection",
                    role: "user",
                    parts: [new TextPart({ type: "text", text: command.message })],
                    createdAt: new Date(),
                  })
                  const item: QueuedTurnItem = {
                    message: interjectMessage,
                    bypass,
                    ...(command.agent !== undefined ? { agentOverride: command.agent } : {}),
                  }
                  const urgent =
                    loopState._tag === "Streaming" || loopState._tag === "ExecutingTools"
                  const content = command.message
                  yield* loop.actor.sendAndWait(
                    AgentLoopEvent.QueueSteering({ item, urgent }),
                    (state) => queueContainsContent(state.queue.steering, content),
                  )
                  return
                }
              }
            }),

          followUp: (message) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(message.sessionId, message.branchId)
              const loopState = yield* loop.actor.snapshot
              if (countQueuedFollowUps(loopState.queue) >= DEFAULTS.followUpQueueMax) {
                return yield* new AgentLoopError({
                  message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                })
              }
              const session = yield* storage
                .getSession(message.sessionId)
                .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
              const bypass = session?.bypass ?? true
              const content = messageText(message)
              yield* loop.actor.sendAndWait(
                AgentLoopEvent.QueueFollowUp({ item: { message, bypass } }),
                (state) => queueContainsContent(state.queue.followUp, content),
              )
            }),

          drainQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return { steering: [], followUp: [] }
              }

              const loopState = yield* loop.actor.snapshot
              const snapshot = queueSnapshotFromState(loopState)
              yield* loop.actor.sendAndWait(
                AgentLoopEvent.ClearQueue,
                (state) => state.queue.steering.length === 0 && state.queue.followUp.length === 0,
              )
              return snapshot
            }),

          getQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return { steering: [], followUp: [] }
              }

              return queueSnapshotFromState(yield* loop.actor.snapshot)
            }),

          isRunning: (input) =>
            Effect.gen(function* () {
              const loop = yield* findLoop(input.sessionId, input.branchId)
              if (loop === undefined) return false
              return (yield* loop.actor.snapshot)._tag !== "Idle"
            }),
        }

        return service
      }),
    )

  static Test = (): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: (_input) => Effect.succeed(false),
    })
}

// ============================================================================
// Agent Actor (subagent runner)
// ============================================================================

const AgentRunInputFields = {
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  prompt: Schema.String,
  systemPrompt: Schema.String,
  bypass: Schema.UndefinedOr(Schema.Boolean),
  modelId: Schema.optional(Schema.String),
  overrideAllowedActions: Schema.optional(Schema.Array(Schema.String)),
  overrideAllowedTools: Schema.optional(Schema.Array(Schema.String)),
  overrideDeniedTools: Schema.optional(Schema.Array(Schema.String)),
  overrideReasoningEffort: Schema.optional(ReasoningEffort),
  overrideSystemPromptAddendum: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
}

const AgentRunInputSchema = Schema.Struct(AgentRunInputFields)

export type AgentRunInput = typeof AgentRunInputSchema.Type

const AgentActorState = State({
  Idle: {},
  Running: { input: AgentRunInputSchema },
  Completed: {},
  Failed: { error: Schema.String },
})

const AgentActorEvent = Event({
  Start: { input: AgentRunInputSchema },
  Succeeded: {},
  Failed: { error: Schema.String },
})

const makeAgentMachine = (run: (input: AgentRunInput) => Effect.Effect<void, SubagentError>) =>
  Machine.make({
    state: AgentActorState,
    event: AgentActorEvent,
    initial: AgentActorState.Idle,
  })
    .on(AgentActorState.Idle, AgentActorEvent.Start, ({ event }) =>
      AgentActorState.Running({ input: event.input }),
    )
    .on(AgentActorState.Running, AgentActorEvent.Succeeded, () => AgentActorState.Completed)
    .on(AgentActorState.Running, AgentActorEvent.Failed, ({ event }) =>
      AgentActorState.Failed({ error: event.error }),
    )
    .task(AgentActorState.Running, ({ state }) => run(state.input), {
      name: "run",
      onSuccess: () => AgentActorEvent.Succeeded,
      onFailure: (cause) => AgentActorEvent.Failed({ error: Cause.pretty(cause) }),
    })
    .final(AgentActorState.Completed)
    .final(AgentActorState.Failed)
    .build()

export interface AgentActorService {
  readonly run: (input: AgentRunInput) => Effect.Effect<void, SubagentError>
}

export class AgentActor extends ServiceMap.Service<AgentActor, AgentActorService>()(
  "@gent/runtime/src/agent/agent-loop/AgentActor",
) {
  static Live: Layer.Layer<
    AgentActor,
    never,
    Storage | Provider | ExtensionRegistry | EventStore | ToolRunner
  > = Layer.effect(
    AgentActor,
    Effect.gen(function* () {
      const storage = yield* Storage
      const provider = yield* Provider
      const extensionRegistry = yield* ExtensionRegistry
      const eventStore = yield* EventStore
      const toolRunner = yield* ToolRunner
      const bashSemaphore = yield* Semaphore.make(1)

      const actorIdFor = (input: AgentRunInput) => `agent-${input.sessionId}-${input.branchId}`

      const publishMachineTaskSucceeded = Effect.fn("AgentActor.publishMachineTaskSucceeded")(
        function* (input: AgentRunInput) {
          yield* eventStore
            .publish(
              new MachineTaskSucceeded({
                sessionId: input.sessionId,
                branchId: input.branchId,
                actorId: actorIdFor(input),
                stateTag: "Running",
              }),
            )
            .pipe(
              Effect.catchEager((e) =>
                Effect.logWarning("failed to publish MachineTaskSucceeded", e),
              ),
            )
        },
      )

      const publishMachineTaskFailed = Effect.fn("AgentActor.publishMachineTaskFailed")(function* (
        input: AgentRunInput,
        cause: Cause.Cause<unknown>,
      ) {
        const error = Cause.pretty(cause)
        yield* eventStore
          .publish(
            new MachineTaskFailed({
              sessionId: input.sessionId,
              branchId: input.branchId,
              actorId: actorIdFor(input),
              stateTag: "Running",
              error,
            }),
          )
          .pipe(
            Effect.catchEager((e) => Effect.logWarning("failed to publish MachineTaskFailed", e)),
          )
      })

      const runEffect: (input: AgentRunInput) => Effect.Effect<void, SubagentError> = Effect.fn(
        "AgentActor.runEffect",
      )((input: AgentRunInput) =>
        Effect.gen(function* () {
          const agent = yield* extensionRegistry.getAgent(input.agentName)
          if (agent === undefined) {
            yield* eventStore.publish(
              new ErrorOccurred({
                sessionId: input.sessionId,
                branchId: input.branchId,
                error: `Unknown agent: ${input.agentName}`,
              }),
            )
            return yield* new SubagentError({ message: `Unknown agent: ${input.agentName}` })
          }

          const effectiveAgent = applyAgentOverrides(agent, input)

          const basePrompt = yield* extensionRegistry.hooks.runInterceptor(
            "prompt.system",
            {
              basePrompt: buildSystemPrompt(input.systemPrompt, effectiveAgent),
              agent: effectiveAgent,
            },
            (i) => Effect.succeed(i.basePrompt),
          )

          const userMessage = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: input.prompt })],
            createdAt: new Date(),
          })

          yield* storage.createMessage(userMessage)
          yield* eventStore.publish(
            new MessageReceived({
              sessionId: input.sessionId,
              branchId: input.branchId,
              messageId: userMessage.id,
              role: "user",
            }),
          )

          const tools = yield* extensionRegistry.listToolsForAgent(effectiveAgent, {
            sessionId: input.sessionId,
            branchId: input.branchId,
            agentName: input.agentName,
            tags: input.tags,
          })

          const messages: Message[] = [userMessage]
          let continueLoop = true

          while (continueLoop) {
            yield* eventStore.publish(
              new StreamStarted({ sessionId: input.sessionId, branchId: input.branchId }),
            )

            const modelId = (input.modelId as ModelId | undefined) ?? resolveAgentModel(agent)
            const reasoning = resolveReasoning(effectiveAgent)
            const streamEffect = yield* withRetry(
              provider.stream({
                model: modelId,
                messages: [...messages],
                tools: [...tools],
                systemPrompt: basePrompt,
                ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
                ...(reasoning !== undefined ? { reasoning } : {}),
              }),
              undefined,
              {
                onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
                  eventStore
                    .publish(
                      new ProviderRetrying({
                        sessionId: input.sessionId,
                        branchId: input.branchId,
                        attempt,
                        maxAttempts,
                        delayMs,
                        error: error.message,
                      }),
                    )
                    .pipe(Effect.orDie),
              },
            ).pipe(Effect.withSpan("AgentActor.provider.stream"))

            const textParts: string[] = []
            const reasoningParts: string[] = []
            const toolCalls: ToolCallPart[] = []
            let lastFinishChunk: FinishChunk | undefined

            yield* Stream.runForEach(streamEffect, (chunk) =>
              Effect.gen(function* () {
                if (chunk._tag === "TextChunk") {
                  textParts.push(chunk.text)
                  yield* eventStore.publish(
                    new EventStreamChunk({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      chunk: chunk.text,
                    }),
                  )
                } else if (chunk._tag === "ReasoningChunk") {
                  reasoningParts.push(chunk.text)
                } else if (chunk._tag === "ToolCallChunk") {
                  const toolCall = new ToolCallPart({
                    type: "tool-call",
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName,
                    input: chunk.input,
                  })
                  toolCalls.push(toolCall)
                } else if (chunk._tag === "FinishChunk") {
                  lastFinishChunk = chunk
                }
              }),
            )

            yield* eventStore.publish(
              new StreamEnded({
                sessionId: input.sessionId,
                branchId: input.branchId,
                usage: lastFinishChunk?.usage,
              }),
            )

            const assistantParts: Array<TextPart | ReasoningPart | ToolCallPart> = []
            const reasoningText = reasoningParts.join("")
            if (reasoningText !== "") {
              assistantParts.push(new ReasoningPart({ type: "reasoning", text: reasoningText }))
            }
            const fullText = textParts.join("")
            if (fullText !== "") {
              assistantParts.push(new TextPart({ type: "text", text: fullText }))
            }
            assistantParts.push(...toolCalls)

            const assistantMessage = new Message({
              id: Bun.randomUUIDv7() as MessageId,
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: assistantParts,
              createdAt: new Date(),
            })

            yield* storage.createMessage(assistantMessage)
            yield* eventStore.publish(
              new MessageReceived({
                sessionId: input.sessionId,
                branchId: input.branchId,
                messageId: assistantMessage.id,
                role: "assistant",
              }),
            )

            if (toolCalls.length > 0) {
              const toolResults = yield* Effect.forEach(
                toolCalls,
                (toolCall) =>
                  Effect.gen(function* () {
                    yield* eventStore.publish(
                      new ToolCallStarted({
                        sessionId: input.sessionId,
                        branchId: input.branchId,
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        input: toolCall.input,
                      }),
                    )

                    const tool = yield* extensionRegistry.getTool(toolCall.toolName)
                    const ctx: ToolContext = {
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      toolCallId: toolCall.toolCallId,
                      agentName: agent.name,
                    }
                    const run = toolRunner.run(toolCall, ctx, { bypass: input.bypass })
                    const result = yield* tool?.concurrency === "serial"
                      ? bashSemaphore.withPermits(1)(run)
                      : run

                    const outputSummary = summarizeToolOutput(result)
                    const isError = result.output.type === "error-json"
                    const toolCallFields = {
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      summary: outputSummary,
                      output: stringifyOutput(result.output.value),
                    }
                    yield* eventStore.publish(
                      isError
                        ? new ToolCallFailed(toolCallFields)
                        : new ToolCallSucceeded(toolCallFields),
                    )

                    return result
                  }),
                { concurrency: Math.max(1, DEFAULTS.toolConcurrency) },
              )

              const toolResultMessage = new Message({
                id: Bun.randomUUIDv7() as MessageId,
                sessionId: input.sessionId,
                branchId: input.branchId,
                role: "tool",
                parts: toolResults,
                createdAt: new Date(),
              })
              yield* storage.createMessage(toolResultMessage)
              messages.push(toolResultMessage)
              continueLoop = true
            } else {
              continueLoop = false
            }
          }
        }).pipe(
          Effect.tap(() => publishMachineTaskSucceeded(input)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : publishMachineTaskFailed(input, cause),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : eventStore
                  .publish(
                    new ErrorOccurred({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      error: Cause.pretty(cause),
                    }),
                  )
                  .pipe(
                    Effect.catchEager((e) =>
                      Effect.logWarning("failed to publish ErrorOccurred event", e),
                    ),
                  ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.fail(new SubagentError({ message: Cause.pretty(cause), cause })),
          ),
        ),
      )

      const run: AgentActorService["run"] = Effect.fn("AgentActor.run")((input) =>
        Effect.gen(function* () {
          const inspector = makePublishingInspector({
            publishEvent: eventStore.publish,
            sessionId: input.sessionId,
            branchId: input.branchId,
          })

          const actorId = actorIdFor(input)
          const actor = yield* Machine.spawn(makeAgentMachine(runEffect), actorId).pipe(
            Effect.provideService(InspectorService, inspector),
            Effect.mapError((error) =>
              Schema.is(SubagentError)(error)
                ? error
                : new SubagentError({ message: String(error), cause: error }),
            ),
          )

          const terminal = yield* actor.sendAndWait(AgentActorEvent.Start({ input }))

          yield* actor.stop

          if (terminal._tag === "Failed") {
            return yield* new SubagentError({ message: terminal.error })
          }
        }),
      )

      return AgentActor.of({ run })
    }),
  )
}
