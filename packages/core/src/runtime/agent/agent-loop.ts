import {
  Cause,
  ServiceMap,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Queue,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import {
  type ActorRef,
  Event,
  InspectorService,
  Machine,
  State,
  makeInspector,
} from "effect-machine"
import {
  AgentDefinition,
  AgentName,
  Agents,
  ReasoningEffort,
  resolveAgentModel,
  SubagentError,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import type { ModelId } from "../../domain/model.js"
import {
  EventStore,
  AgentSwitched,
  StreamStarted,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  TurnCompleted,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
  MessageReceived,
  ErrorOccurred,
  ProviderRetrying,
  MachineInspected,
  MachineTaskFailed,
  MachineTaskSucceeded,
  type AgentEvent,
  type EventStoreError,
} from "../../domain/event.js"
import { Message, TextPart, ReasoningPart, ToolCallPart } from "../../domain/message.js"
import { SessionId, BranchId, type MessageId } from "../../domain/ids.js"
import { type AnyToolDefinition, type ToolAction, type ToolContext } from "../../domain/tool.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { HandoffHandler, type HandoffHandlerService } from "../../domain/interaction-handlers.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Storage, type StorageError, type StorageService } from "../../storage/sqlite-storage.js"
import {
  Provider,
  type ProviderError,
  type FinishChunk,
  type ProviderRequest,
  type StreamChunk as ProviderStreamChunk,
} from "../../providers/provider.js"
import { withRetry } from "../retry"
import { estimateContextPercent } from "../context-estimation"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { ToolRunner, type ToolRunnerService } from "./tool-runner"

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
): ProviderRequest["reasoning"] | undefined => {
  if (sessionOverride !== undefined && VALID_REASONING_LEVELS.has(sessionOverride)) {
    return sessionOverride as ProviderRequest["reasoning"]
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

type FollowUpItem = {
  message: Message
  bypass: boolean
  agentOverride?: AgentNameType
}

const getSingleText = (message: Message): string | undefined => {
  if (message.parts.length !== 1) return undefined
  const [part] = message.parts
  return part?.type === "text" ? part.text : undefined
}

const canBatchQueuedFollowUp = (existing: FollowUpItem, incoming: FollowUpItem): boolean => {
  if (existing.agentOverride !== undefined || incoming.agentOverride !== undefined) return false
  if (existing.message.role !== "user" || incoming.message.role !== "user") return false
  if (existing.message.kind === "interjection" || incoming.message.kind === "interjection")
    return false
  return (
    getSingleText(existing.message) !== undefined && getSingleText(incoming.message) !== undefined
  )
}

const mergeQueuedFollowUp = (existing: FollowUpItem, incoming: FollowUpItem): FollowUpItem => {
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
  queue: ReadonlyArray<FollowUpItem>,
  item: FollowUpItem,
): FollowUpItem[] => {
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

const formatStreamErrorMessage = (streamError: unknown) => {
  if (streamError instanceof Error) return streamError.message
  if ("message" in (streamError as Record<string, unknown>)) {
    return String((streamError as Record<string, unknown>)["message"])
  }
  return String(streamError)
}

const enqueueInterjectionMessage = (params: {
  sessionId: SessionId
  branchId: BranchId
  bypass: boolean
  steeringMessageQueue: Ref.Ref<FollowUpItem[]>
  content: string
  agentOverride?: AgentNameType
  createdAt?: Date
}) =>
  Effect.gen(function* () {
    const interjectMsg = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      kind: "interjection",
      role: "user",
      parts: [new TextPart({ type: "text", text: params.content })],
      createdAt: params.createdAt ?? new Date(),
    })
    yield* Ref.update(params.steeringMessageQueue, (queue) => [
      ...queue,
      {
        message: interjectMsg,
        bypass: params.bypass,
        ...(params.agentOverride !== undefined ? { agentOverride: params.agentOverride } : {}),
      },
    ])
  })

const persistAssistantText = (params: {
  storage: StorageService
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  appendCachedMessage: (message: Message) => void
  sessionId: SessionId
  branchId: BranchId
  text: string
  reasoning: string
  createdAt?: Date
}) =>
  Effect.gen(function* () {
    if (params.text === "" && params.reasoning === "") return undefined

    const parts: Array<TextPart | ReasoningPart> = []
    if (params.reasoning !== "") {
      parts.push(new ReasoningPart({ type: "reasoning", text: params.reasoning }))
    }
    if (params.text !== "") {
      parts.push(new TextPart({ type: "text", text: params.text }))
    }

    const message = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "assistant",
      parts,
      createdAt: params.createdAt ?? new Date(),
    })
    yield* params.storage.createMessage(message)
    params.appendCachedMessage(message)
    yield* params.publishEvent(
      new MessageReceived({
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: message.id,
        role: "assistant",
      }),
    )
    return message
  })

const drainQueuedTurn = (params: {
  steeringMessageQueue: Ref.Ref<FollowUpItem[]>
  followUpQueue: Ref.Ref<FollowUpItem[]>
  runLoopRecovering: (
    message: Message,
    bypass: boolean,
    agentOverride?: AgentNameType,
  ) => Effect.Effect<boolean, AgentLoopError | StorageError | ProviderError | EventStoreError>
}) =>
  Effect.gen(function* () {
    const steeringItems = yield* Ref.get(params.steeringMessageQueue)
    const nextSteer = steeringItems[0]
    if (nextSteer !== undefined) {
      yield* Ref.update(params.steeringMessageQueue, (items) => items.slice(1))
      return yield* params.runLoopRecovering(
        nextSteer.message,
        nextSteer.bypass,
        nextSteer.agentOverride,
      )
    }

    const queue = yield* Ref.get(params.followUpQueue)
    const nextItem = queue[0]
    if (nextItem === undefined) return false
    yield* Ref.update(params.followUpQueue, (items) => items.slice(1))
    return yield* params.runLoopRecovering(restampQueuedMessage(nextItem.message), nextItem.bypass)
  })

const summarizeRecentMessages = (messages: ReadonlyArray<Message>) => {
  const recentText = messages
    .slice(-20)
    .map((m) => {
      const text = m.parts
        .filter((p): p is typeof TextPart.Type => p.type === "text")
        .map((p) => p.text)
        .join("\n")
      return text !== "" ? `${m.role}: ${text}` : ""
    })
    .filter((line) => line.length > 0)
    .join("\n\n")
  return recentText.length > 0 ? recentText.slice(0, 4000) : "Session context"
}

const runAutoHandoffIfNeeded = (params: {
  turnInterrupted: boolean
  handoffSuppressRef: Ref.Ref<number>
  storage: StorageService
  branchId: BranchId
  resolveCurrentAgent: Effect.Effect<AgentNameType, never>
  extensionRegistry: ExtensionRegistryService
  sessionId: SessionId
  handoffHandler: HandoffHandlerService
}) =>
  Effect.gen(function* () {
    if (params.turnInterrupted) return

    const suppressLeft = yield* Ref.get(params.handoffSuppressRef)
    if (suppressLeft > 0) {
      yield* Ref.update(params.handoffSuppressRef, (n) => n - 1)
      return
    }

    const allMessages = yield* params.storage.listMessages(params.branchId)
    const currentAgent = yield* params.resolveCurrentAgent
    const currentAgentDef = yield* params.extensionRegistry.getAgent(currentAgent)
    const modelId = resolveAgentModel(currentAgentDef ?? Agents.cowork)
    const contextPercent = estimateContextPercent(allMessages, modelId)
    if (contextPercent < DEFAULTS.handoffThresholdPercent) return

    yield* Effect.logInfo("auto-handoff.threshold").pipe(
      Effect.annotateLogs({
        contextPercent,
        threshold: DEFAULTS.handoffThresholdPercent,
      }),
    )
    const decision = yield* params.handoffHandler
      .present({
        sessionId: params.sessionId,
        branchId: params.branchId,
        summary: summarizeRecentMessages(allMessages),
        reason: `Context at ${contextPercent}% (threshold: ${DEFAULTS.handoffThresholdPercent}%)`,
      })
      .pipe(Effect.catchEager(() => Effect.succeed("reject" as const)))

    if (decision === "reject") {
      yield* Ref.set(params.handoffSuppressRef, 5)
    }
  })

const handlePolledSteerCommand = (params: {
  cmd: SteerCommand
  applySteerCommand: (
    cmd: Extract<SteerCommand, { _tag: "SwitchAgent" }>,
  ) => Effect.Effect<void, AgentLoopError>
  enqueueInterject: (
    content: string,
    agentOverride?: AgentNameType,
    createdAt?: Date,
  ) => Effect.Effect<void, never>
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  setTurnInterrupted: () => void
  stopLoop: () => void
}) =>
  Effect.gen(function* () {
    if (params.cmd._tag === "SwitchAgent") {
      yield* params.applySteerCommand(params.cmd)
      return false
    }

    if (params.cmd._tag === "Interject") {
      yield* params.enqueueInterject(params.cmd.message, params.cmd.agent)
    } else {
      params.setTurnInterrupted()
      yield* params.publishEvent(
        new StreamEnded({
          sessionId: params.sessionId,
          branchId: params.branchId,
          interrupted: true,
        }),
      )
    }

    params.stopLoop()
    return true
  })

const handleInterruptCommand = (params: {
  interruptCmd: SteerCommand
  partialText: string
  partialReasoning: string
  sessionId: SessionId
  branchId: BranchId
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  persistAssistantText: (
    text: string,
    reasoning: string,
    createdAt?: Date,
  ) => Effect.Effect<Message | undefined, StorageError | AgentLoopError>
  enqueueInterject: (
    content: string,
    agentOverride?: AgentNameType,
    createdAt?: Date,
  ) => Effect.Effect<void, never>
  setTurnInterrupted: () => void
  stopLoop: () => void
}) =>
  Effect.gen(function* () {
    params.setTurnInterrupted()
    yield* params.publishEvent(
      new StreamEnded({
        sessionId: params.sessionId,
        branchId: params.branchId,
        interrupted: true,
      }),
    )

    const createdAt = new Date()
    const partialMessage = yield* params.persistAssistantText(
      params.partialText,
      params.partialReasoning,
      createdAt,
    )

    if (params.interruptCmd._tag === "Interject") {
      const interjectCreatedAt =
        partialMessage !== undefined ? new Date(partialMessage.createdAt.getTime() + 1) : new Date()
      yield* params.enqueueInterject(
        params.interruptCmd.message,
        params.interruptCmd.agent,
        interjectCreatedAt,
      )
    }

    params.stopLoop()
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

interface CollectedStreamResponse {
  textParts: string[]
  reasoningParts: string[]
  toolCalls: ToolCallPart[]
  lastFinishChunk?: FinishChunk
  streamFailed: boolean
  interruptCmd: SteerCommand | null
}

interface ResolvedTurnContext {
  currentAgent: AgentNameType
  messages: Message[]
  agent: AgentDefinition
  tools: ReadonlyArray<AnyToolDefinition>
  systemPrompt: string
  modelId: ModelId
  reasoning: ProviderRequest["reasoning"] | undefined
}

interface LoopIterationResult {
  cachedMessages: Message[]
  continueLoop: boolean
  shouldBreak: boolean
  shouldReturnInterrupted: boolean
}

const collectStreamResponse = (params: {
  streamEffect: Stream.Stream<ProviderStreamChunk, ProviderError>
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  abortController: AbortController
  steerQueue: Queue.Queue<SteerCommand>
  pendingSteerRef: Ref.Ref<SteerCommand[]>
  persistAssistantText: (
    text: string,
    reasoning: string,
    createdAt?: Date,
  ) => Effect.Effect<Message | undefined, StorageError | AgentLoopError>
}) =>
  Effect.gen(function* () {
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls: ToolCallPart[] = []
    let lastFinishChunk: FinishChunk | undefined
    const interruptRef = yield* Ref.make<SteerCommand | null>(null)

    const interruptSignal = Effect.gen(function* () {
      while (true) {
        const cmd = yield* Queue.take(params.steerQueue)
        if (cmd._tag === "Cancel" || cmd._tag === "Interrupt" || cmd._tag === "Interject") {
          yield* Ref.set(interruptRef, cmd)
          params.abortController.abort()
          return
        }
        yield* Ref.update(params.pendingSteerRef, (pending) => [...pending, cmd])
      }
    })

    const streamFailed = yield* Stream.runForEach(
      params.streamEffect.pipe(Stream.interruptWhen(interruptSignal)),
      (chunk) =>
        Effect.gen(function* () {
          if (chunk._tag === "TextChunk") {
            textParts.push(chunk.text)
            yield* params.publishEvent(
              new EventStreamChunk({
                sessionId: params.sessionId,
                branchId: params.branchId,
                chunk: chunk.text,
              }),
            )
            return
          }
          if (chunk._tag === "ReasoningChunk") {
            reasoningParts.push(chunk.text)
            return
          }
          if (chunk._tag === "ToolCallChunk") {
            toolCalls.push(
              new ToolCallPart({
                type: "tool-call",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              }),
            )
            return
          }
          if (chunk._tag === "FinishChunk") {
            lastFinishChunk = chunk
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchEager((streamError) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("stream error, persisting partial output", streamError)
          yield* params.persistAssistantText(textParts.join(""), reasoningParts.join(""))
          yield* params.publishEvent(
            new StreamEnded({ sessionId: params.sessionId, branchId: params.branchId }),
          )
          yield* params.publishEvent(
            new ErrorOccurred({
              sessionId: params.sessionId,
              branchId: params.branchId,
              error: formatStreamErrorMessage(streamError),
            }),
          )
          return true
        }),
      ),
    )

    const interruptCmd = yield* Ref.get(interruptRef)
    return { textParts, reasoningParts, toolCalls, lastFinishChunk, streamFailed, interruptCmd }
  })

const persistAssistantTurn = (params: {
  storage: StorageService
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  appendCachedMessage: (message: Message) => void
  sessionId: SessionId
  branchId: BranchId
  textParts: ReadonlyArray<string>
  reasoningParts: ReadonlyArray<string>
  toolCalls: ReadonlyArray<ToolCallPart>
}) =>
  Effect.gen(function* () {
    const assistantParts: Array<TextPart | ReasoningPart | ToolCallPart> = []
    const reasoningText = params.reasoningParts.join("")
    if (reasoningText !== "") {
      assistantParts.push(new ReasoningPart({ type: "reasoning", text: reasoningText }))
    }
    const fullText = params.textParts.join("")
    if (fullText !== "") {
      assistantParts.push(new TextPart({ type: "text", text: fullText }))
    }
    assistantParts.push(...params.toolCalls)

    const assistantMessage = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "assistant",
      parts: assistantParts,
      createdAt: new Date(),
    })

    yield* params.storage.createMessage(assistantMessage)
    params.appendCachedMessage(assistantMessage)
    yield* params.publishEvent(
      new MessageReceived({
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: assistantMessage.id,
        role: "assistant",
      }),
    )
  })

const executeToolCalls = (params: {
  toolCalls: ReadonlyArray<ToolCallPart>
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  currentAgent: AgentNameType
  bypass: boolean
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  bashSemaphore: SemaphoreType
}) =>
  Effect.forEach(
    params.toolCalls,
    (toolCall) =>
      Effect.gen(function* () {
        yield* params.publishEvent(
          new ToolCallStarted({
            sessionId: params.sessionId,
            branchId: params.branchId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          }),
        )

        const ctx: ToolContext = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          toolCallId: toolCall.toolCallId,
          agentName: params.currentAgent,
        }
        const run = params.toolRunner.run(toolCall, ctx, { bypass: params.bypass })
        const tool = yield* params.extensionRegistry.getTool(toolCall.toolName)
        const result = yield* tool?.concurrency === "serial"
          ? params.bashSemaphore.withPermits(1)(run)
          : run

        const outputSummary = summarizeToolOutput(result)
        const isError = result.output.type === "error-json"
        const toolCallFields = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          summary: outputSummary,
          output: stringifyOutput(result.output.value),
        }
        yield* params.publishEvent(
          isError ? new ToolCallFailed(toolCallFields) : new ToolCallSucceeded(toolCallFields),
        )
        yield* Effect.logInfo("tool.completed").pipe(
          Effect.annotateLogs({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            isError,
          }),
        )

        return result
      }),
    { concurrency: Math.max(1, DEFAULTS.toolConcurrency) },
  )

const pollSteerAndMaybeBreak = (params: {
  steerQueue: Queue.Queue<SteerCommand>
  handlePolledSteerCommand: (cmd: SteerCommand) => Effect.Effect<boolean, AgentLoopError>
}) =>
  Effect.gen(function* () {
    const steerCmd = yield* Queue.poll(params.steerQueue)
    if (steerCmd._tag !== "Some") return false
    return yield* params.handlePolledSteerCommand(steerCmd.value)
  })

const resolveTurnContext = (params: {
  agentOverride?: AgentNameType
  resolveCurrentAgent: Effect.Effect<AgentNameType, never>
  cachedMessages: Message[] | undefined
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  sessionId: SessionId
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  systemPrompt: string
}): Effect.Effect<
  { context?: ResolvedTurnContext; cachedMessages: Message[] },
  AgentLoopError | StorageError
> =>
  Effect.gen(function* () {
    const currentAgent = params.agentOverride ?? (yield* params.resolveCurrentAgent)
    const messages =
      params.cachedMessages ??
      (yield* params.storage.listMessages(params.branchId).pipe(Effect.map((m) => [...m])))
    const agent = yield* params.extensionRegistry.getAgent(currentAgent)
    if (agent === undefined) {
      yield* params.publishEvent(
        new ErrorOccurred({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: `Unknown agent: ${currentAgent}`,
        }),
      )
      return { cachedMessages: messages }
    }

    const tools = yield* params.extensionRegistry.listToolsForAgent(agent, {
      sessionId: params.sessionId,
      branchId: params.branchId,
      agentName: currentAgent,
    })
    const systemPrompt = yield* params.extensionRegistry.hooks.runInterceptor(
      "prompt.system",
      { basePrompt: buildSystemPrompt(params.systemPrompt, agent), agent },
      (input) => Effect.succeed(input.basePrompt),
    )
    const session = yield* params.storage
      .getSession(params.sessionId)
      .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
    return {
      cachedMessages: messages,
      context: {
        currentAgent,
        messages,
        agent,
        tools,
        systemPrompt,
        modelId: resolveAgentModel(agent),
        reasoning: resolveReasoning(agent, session?.reasoningLevel),
      },
    }
  })

const handleCollectedInterrupt = (params: {
  collected: CollectedStreamResponse
  sessionId: SessionId
  branchId: BranchId
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  persistAssistantText: (
    text: string,
    reasoning: string,
    createdAt?: Date,
  ) => Effect.Effect<Message | undefined, StorageError | AgentLoopError>
  enqueueInterject: (
    content: string,
    agentOverride?: AgentNameType,
    createdAt?: Date,
  ) => Effect.Effect<void, never>
  setTurnInterrupted: () => void
  stopLoop: () => void
}) =>
  Effect.gen(function* () {
    if (params.collected.interruptCmd === null) return false
    yield* handleInterruptCommand({
      interruptCmd: params.collected.interruptCmd,
      partialText: params.collected.textParts.join(""),
      partialReasoning: params.collected.reasoningParts.join(""),
      sessionId: params.sessionId,
      branchId: params.branchId,
      publishEvent: params.publishEvent,
      persistAssistantText: params.persistAssistantText,
      enqueueInterject: params.enqueueInterject,
      setTurnInterrupted: params.setTurnInterrupted,
      stopLoop: params.stopLoop,
    })
    return true
  })

const storeToolResultsIfAny = (params: {
  collected: CollectedStreamResponse
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  currentAgent: AgentNameType
  bypass: boolean
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  bashSemaphore: SemaphoreType
  storage: StorageService
  appendCachedMessage: (message: Message) => void
}) =>
  Effect.gen(function* () {
    if (params.collected.toolCalls.length === 0) return false
    const toolResults = yield* executeToolCalls({
      toolCalls: params.collected.toolCalls,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentAgent: params.currentAgent,
      bypass: params.bypass,
      toolRunner: params.toolRunner,
      extensionRegistry: params.extensionRegistry,
      bashSemaphore: params.bashSemaphore,
    })

    const toolResultMessage = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "tool",
      parts: toolResults,
      createdAt: new Date(),
    })
    yield* params.storage.createMessage(toolResultMessage)
    params.appendCachedMessage(toolResultMessage)
    return true
  })

const runLoopIteration = (params: {
  applyPendingSteerCommands: Effect.Effect<void, AgentLoopError>
  steerQueue: Queue.Queue<SteerCommand>
  handlePolledSteerCommand: (cmd: SteerCommand) => Effect.Effect<boolean, AgentLoopError>
  agentOverride?: AgentNameType
  resolveCurrentAgent: Effect.Effect<AgentNameType, never>
  cachedMessages: Message[] | undefined
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  sessionId: SessionId
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  systemPrompt: string
  provider: typeof Provider.Service
  pendingSteerRef: Ref.Ref<SteerCommand[]>
  persistAssistantText: (
    text: string,
    reasoning: string,
    createdAt?: Date,
  ) => Effect.Effect<Message | undefined, StorageError | AgentLoopError>
  enqueueInterject: (
    content: string,
    agentOverride?: AgentNameType,
    createdAt?: Date,
  ) => Effect.Effect<void, never>
  setTurnInterrupted: () => void
  bypass: boolean
  toolRunner: ToolRunnerService
  bashSemaphore: SemaphoreType
  appendCachedMessage: (message: Message) => void
}): Effect.Effect<LoopIterationResult, AgentLoopError | StorageError | ProviderError> =>
  Effect.gen(function* () {
    yield* params.applyPendingSteerCommands

    let continueLoop = true
    const shouldBreak = yield* pollSteerAndMaybeBreak({
      steerQueue: params.steerQueue,
      handlePolledSteerCommand: (cmd) =>
        params
          .handlePolledSteerCommand(cmd)
          .pipe(
            Effect.tap((didBreak) =>
              didBreak ? Effect.sync(() => void (continueLoop = false)) : Effect.void,
            ),
          ),
    })
    if (shouldBreak) {
      return {
        cachedMessages: params.cachedMessages ?? [],
        continueLoop,
        shouldBreak: true,
        shouldReturnInterrupted: false,
      }
    }

    const resolved = yield* resolveTurnContext({
      agentOverride: params.agentOverride,
      resolveCurrentAgent: params.resolveCurrentAgent,
      cachedMessages: params.cachedMessages,
      storage: params.storage,
      branchId: params.branchId,
      extensionRegistry: params.extensionRegistry,
      sessionId: params.sessionId,
      publishEvent: params.publishEvent,
      systemPrompt: params.systemPrompt,
    })
    if (resolved.context === undefined) {
      return {
        cachedMessages: resolved.cachedMessages,
        continueLoop: false,
        shouldBreak: true,
        shouldReturnInterrupted: true,
      }
    }

    const { currentAgent, messages, agent, tools, systemPrompt, modelId, reasoning } =
      resolved.context

    yield* params.publishEvent(
      new StreamStarted({ sessionId: params.sessionId, branchId: params.branchId }),
    )
    yield* Effect.logInfo("stream.start").pipe(
      Effect.annotateLogs({
        agent: currentAgent,
        model: modelId,
      }),
    )

    const abortController = new AbortController()
    const streamEffect = yield* withRetry(
      params.provider.stream({
        model: modelId,
        messages: [...messages],
        tools: [...tools],
        systemPrompt,
        abortSignal: abortController.signal,
        ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
      }),
      undefined,
      {
        onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
          params
            .publishEvent(
              new ProviderRetrying({
                sessionId: params.sessionId,
                branchId: params.branchId,
                attempt,
                maxAttempts,
                delayMs,
                error: error.message,
              }),
            )
            .pipe(Effect.orDie),
      },
    ).pipe(Effect.withSpan("AgentLoop.provider.stream"))

    const collected = yield* collectStreamResponse({
      streamEffect,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      abortController,
      steerQueue: params.steerQueue,
      pendingSteerRef: params.pendingSteerRef,
      persistAssistantText: params.persistAssistantText,
    })
    if (collected.streamFailed) {
      return {
        cachedMessages: resolved.cachedMessages,
        continueLoop: false,
        shouldBreak: true,
        shouldReturnInterrupted: false,
      }
    }

    yield* params.applyPendingSteerCommands
    const interrupted = yield* handleCollectedInterrupt({
      collected,
      sessionId: params.sessionId,
      branchId: params.branchId,
      publishEvent: params.publishEvent,
      persistAssistantText: params.persistAssistantText,
      enqueueInterject: params.enqueueInterject,
      setTurnInterrupted: params.setTurnInterrupted,
      stopLoop: () => {
        continueLoop = false
      },
    })
    if (interrupted) {
      return {
        cachedMessages: resolved.cachedMessages,
        continueLoop,
        shouldBreak: true,
        shouldReturnInterrupted: false,
      }
    }

    yield* params.publishEvent(
      new StreamEnded({
        sessionId: params.sessionId,
        branchId: params.branchId,
        usage: collected.lastFinishChunk?.usage,
      }),
    )
    yield* Effect.logInfo("stream.end").pipe(
      Effect.annotateLogs({
        inputTokens: collected.lastFinishChunk?.usage?.inputTokens ?? 0,
        outputTokens: collected.lastFinishChunk?.usage?.outputTokens ?? 0,
        toolCallCount: collected.toolCalls.length,
      }),
    )

    yield* persistAssistantTurn({
      storage: params.storage,
      publishEvent: params.publishEvent,
      appendCachedMessage: params.appendCachedMessage,
      sessionId: params.sessionId,
      branchId: params.branchId,
      textParts: collected.textParts,
      reasoningParts: collected.reasoningParts,
      toolCalls: collected.toolCalls,
    })

    const shouldContinue = yield* storeToolResultsIfAny({
      collected,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentAgent,
      bypass: params.bypass,
      toolRunner: params.toolRunner,
      extensionRegistry: params.extensionRegistry,
      bashSemaphore: params.bashSemaphore,
      storage: params.storage,
      appendCachedMessage: params.appendCachedMessage,
    })

    return {
      cachedMessages: resolved.cachedMessages,
      continueLoop: shouldContinue,
      shouldBreak: false,
      shouldReturnInterrupted: false,
    }
  })

type LoopActor = ActorRef<typeof AgentLoopState.Type, typeof AgentLoopEvent.Type>

type SemaphoreType = Semaphore.Semaphore

type LoopHandle = {
  actor: LoopActor
  steerQueue: Queue.Queue<SteerCommand>
  pendingSteerRef: Ref.Ref<SteerCommand[]>
  steeringMessageQueue: Ref.Ref<FollowUpItem[]>
  followUpQueue: Ref.Ref<FollowUpItem[]>
  currentAgentRef: Ref.Ref<AgentNameType | undefined>
  bashSemaphore: SemaphoreType
}

// Agent Loop Machine

const AgentLoopState = State({
  Idle: {},
  Running: { message: Message, bypass: Schema.Boolean },
  Interrupted: { sessionId: SessionId, branchId: BranchId },
})

const AgentLoopEvent = Event({
  Start: { message: Message, bypass: Schema.UndefinedOr(Schema.Boolean) },
  Completed: { interrupted: Schema.Boolean, sessionId: SessionId, branchId: BranchId },
  Failed: { error: Schema.String },
})

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
  }) => Effect.Effect<{ steering: string[]; followUp: string[] }>
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<{ steering: string[]; followUp: string[] }>
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
            const steerQueue = yield* Queue.unbounded<SteerCommand>()
            const pendingSteerRef = yield* Ref.make<SteerCommand[]>([])
            const steeringMessageQueue = yield* Ref.make<FollowUpItem[]>([])
            const followUpQueue = yield* Ref.make<FollowUpItem[]>([])
            const handoffSuppressRef = yield* Ref.make(0) // turns to suppress handoff after reject
            const currentAgentRef = yield* Ref.make<AgentNameType | undefined>(undefined)

            const resolveCurrentAgent = Effect.fn("AgentLoop.resolveCurrentAgent")(function* () {
              const existing = yield* Ref.get(currentAgentRef)
              if (existing !== undefined) return existing

              const latestAgentEvent = yield* storage
                .getLatestEvent({ sessionId, branchId, tags: ["AgentSwitched"] })
                .pipe(Effect.catchEager(() => Effect.succeed(undefined)))

              const raw =
                latestAgentEvent !== undefined && latestAgentEvent._tag === "AgentSwitched"
                  ? latestAgentEvent.toAgent
                  : undefined
              const next: AgentNameType = Schema.is(AgentName)(raw) ? raw : "cowork"

              yield* Ref.set(currentAgentRef, next)
              return next
            })

            const applySteerCommand = Effect.fn("AgentLoop.applySteerCommand")(function* (
              cmd: SteerCommand,
            ) {
              const previous = yield* resolveCurrentAgent()
              if (!("agent" in cmd)) return
              const next: AgentNameType = Schema.is(AgentName)(cmd.agent) ? cmd.agent : "cowork"
              if (previous === next) return
              const resolved = yield* extensionRegistry.getAgent(next)
              if (resolved === undefined) return

              yield* Ref.set(currentAgentRef, next)

              yield* publishEvent(
                new AgentSwitched({
                  sessionId,
                  branchId,
                  fromAgent: previous,
                  toAgent: next,
                }),
              )
            })

            const applyPendingSteerCommands = Effect.fn("AgentLoop.applyPendingSteerCommands")(
              function* () {
                const pending = yield* Ref.getAndSet(pendingSteerRef, [])
                if (pending.length === 0) return
                for (const cmd of pending) {
                  yield* applySteerCommand(cmd)
                }
              },
            )

            const runLoop: (
              initialMessage: Message,
              bypass: boolean,
              agentOverride?: AgentNameType,
            ) => Effect.Effect<
              boolean,
              AgentLoopError | StorageError | ProviderError | EventStoreError
            > = Effect.fn("AgentLoop.runLoop")(function* (
              initialMessage: Message,
              bypass: boolean,
              agentOverride?: AgentNameType,
            ) {
              // Save user message
              yield* storage.createMessage(initialMessage)
              yield* publishEvent(
                new MessageReceived({
                  sessionId,
                  branchId,
                  messageId: initialMessage.id,
                  role: "user",
                }),
              )

              yield* Effect.logInfo("turn.start")

              // Track turn start time and interruption state
              const turnStartTime = yield* DateTime.now
              let turnInterrupted = false
              let interrupted = false

              let continueLoop = true
              let cachedMessages: Message[] | undefined

              const appendCachedMessage = (message: Message) => {
                if (cachedMessages !== undefined) cachedMessages.push(message)
              }

              const enqueueInterjectLocal = (
                content: string,
                nextAgentOverride?: AgentNameType,
                createdAt?: Date,
              ) =>
                enqueueInterjectionMessage({
                  sessionId,
                  branchId,
                  bypass,
                  steeringMessageQueue,
                  content,
                  agentOverride: nextAgentOverride,
                  createdAt,
                })

              const persistAssistantTextLocal = (
                text: string,
                reasoning: string,
                createdAt?: Date,
              ) =>
                persistAssistantText({
                  storage,
                  publishEvent,
                  appendCachedMessage,
                  sessionId,
                  branchId,
                  text,
                  reasoning,
                  createdAt,
                })

              while (continueLoop) {
                const iteration = yield* runLoopIteration({
                  applyPendingSteerCommands: applyPendingSteerCommands(),
                  steerQueue,
                  handlePolledSteerCommand: (cmd) =>
                    handlePolledSteerCommand({
                      cmd,
                      applySteerCommand,
                      enqueueInterject: enqueueInterjectLocal,
                      publishEvent,
                      sessionId,
                      branchId,
                      setTurnInterrupted: () => {
                        turnInterrupted = true
                      },
                      stopLoop: () => {
                        continueLoop = false
                      },
                    }),
                  agentOverride,
                  resolveCurrentAgent: resolveCurrentAgent(),
                  cachedMessages,
                  storage,
                  branchId,
                  extensionRegistry,
                  sessionId,
                  publishEvent,
                  systemPrompt: config.systemPrompt,
                  provider,
                  pendingSteerRef,
                  persistAssistantText: persistAssistantTextLocal,
                  enqueueInterject: enqueueInterjectLocal,
                  setTurnInterrupted: () => {
                    turnInterrupted = true
                  },
                  bypass,
                  toolRunner,
                  bashSemaphore,
                  appendCachedMessage,
                })
                cachedMessages = iteration.cachedMessages
                continueLoop = iteration.continueLoop
                if (iteration.shouldReturnInterrupted) return interrupted
                if (iteration.shouldBreak) break
              }

              interrupted = interrupted || turnInterrupted

              // Update user message with turn duration and emit TurnCompleted
              const turnEndTime = yield* DateTime.now
              const turnDurationMs =
                DateTime.toEpochMillis(turnEndTime) - DateTime.toEpochMillis(turnStartTime)
              yield* storage.updateMessageTurnDuration(initialMessage.id, turnDurationMs)
              yield* publishEvent(
                new TurnCompleted({
                  sessionId,
                  branchId,
                  durationMs: Number(turnDurationMs),
                  ...(turnInterrupted ? { interrupted: true } : {}),
                }),
              )
              yield* Effect.logInfo("turn.completed").pipe(
                Effect.annotateLogs({
                  durationMs: Number(turnDurationMs),
                  interrupted: turnInterrupted,
                }),
              )

              yield* runAutoHandoffIfNeeded({
                turnInterrupted,
                handoffSuppressRef,
                storage,
                branchId,
                resolveCurrentAgent: resolveCurrentAgent(),
                extensionRegistry,
                sessionId,
                handoffHandler,
              })
              const nextInterrupted = yield* drainQueuedTurn({
                steeringMessageQueue,
                followUpQueue,
                runLoopRecovering,
              })
              interrupted = interrupted || nextInterrupted

              return interrupted
            })

            let runLoopRecovering: (
              message: Message,
              bypass: boolean,
              agentOverride?: AgentNameType,
            ) => Effect.Effect<
              boolean,
              AgentLoopError | StorageError | ProviderError | EventStoreError
            >

            const runQueuedAfterFailure: () => Effect.Effect<
              void,
              AgentLoopError | StorageError | ProviderError | EventStoreError
            > = Effect.fn("AgentLoop.runQueuedAfterFailure")(function* () {
              yield* drainQueuedTurn({
                steeringMessageQueue,
                followUpQueue,
                runLoopRecovering,
              }).pipe(Effect.asVoid)
            })

            runLoopRecovering = (
              message: Message,
              bypass: boolean,
              agentOverride?: AgentNameType,
            ) =>
              runLoop(message, bypass, agentOverride).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.gen(function* () {
                        yield* runQueuedAfterFailure()
                        return yield* Effect.failCause(cause)
                      }),
                ),
              )

            const loopMachine = Machine.make({
              state: AgentLoopState,
              event: AgentLoopEvent,
              initial: AgentLoopState.Idle,
            })
              .on(AgentLoopState.Idle, AgentLoopEvent.Start, ({ event }) =>
                AgentLoopState.Running({ message: event.message, bypass: event.bypass ?? true }),
              )
              .on(AgentLoopState.Interrupted, AgentLoopEvent.Start, ({ event }) =>
                AgentLoopState.Running({ message: event.message, bypass: event.bypass ?? true }),
              )
              .on(AgentLoopState.Running, AgentLoopEvent.Completed, ({ event }) =>
                event.interrupted
                  ? AgentLoopState.Interrupted({
                      sessionId: event.sessionId,
                      branchId: event.branchId,
                    })
                  : AgentLoopState.Idle,
              )
              .on(AgentLoopState.Running, AgentLoopEvent.Failed, () => AgentLoopState.Idle)
              .task(
                AgentLoopState.Running,
                ({ state }) =>
                  runLoopRecovering(state.message, state.bypass).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.run"),
                    Effect.tapCause((cause) =>
                      publishEvent(
                        new ErrorOccurred({
                          sessionId,
                          branchId,
                          error: Cause.pretty(cause),
                        }),
                      ).pipe(
                        Effect.catchEager((e) =>
                          Effect.logWarning("failed to publish ErrorOccurred event", e),
                        ),
                      ),
                    ),
                  ),
                {
                  onSuccess: (interrupted: boolean) =>
                    AgentLoopEvent.Completed({
                      interrupted,
                      sessionId,
                      branchId,
                    }),
                  onFailure: (cause) => AgentLoopEvent.Failed({ error: Cause.pretty(cause) }),
                },
              )
              .build()

            const loopActor = yield* Machine.spawn(loopMachine)

            return {
              actor: loopActor,
              steerQueue,
              pendingSteerRef,
              steeringMessageQueue,
              followUpQueue,
              currentAgentRef,
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
            const isRunning = yield* loop.actor.matches("Running")

            if (isRunning) {
              yield* Ref.update(loop.followUpQueue, (queue) =>
                appendFollowUpItem(queue, { message, bypass }),
              )
              return
            }

            // Use sync subscribe to avoid SubscriptionRef semaphore deadlock.
            // Subscribe BEFORE sending Start so we can't miss fast transitions.
            const done = yield* Deferred.make<void>()
            const services = yield* Effect.services<never>()
            let sawRunning = false
            const unsubscribe = loop.actor.subscribe((state) => {
              if (state._tag === "Running") {
                sawRunning = true
              } else if (sawRunning) {
                Effect.runForkWith(services)(Deferred.succeed(done, void 0))
              }
            })

            yield* loop.actor.send(AgentLoopEvent.Start({ message, bypass }))
            yield* Deferred.await(done)
            unsubscribe()
          }),

          steer: (command) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(command.sessionId, command.branchId)
              if (command._tag !== "Interject") {
                yield* Queue.offer(loop.steerQueue, command)
                return
              }

              const isRunning = yield* loop.actor.matches("Running")
              if (!isRunning) {
                yield* Queue.offer(loop.steerQueue, command)
                return
              }

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

              yield* Ref.update(loop.steeringMessageQueue, (items) => [
                ...items,
                {
                  message: interjectMessage,
                  bypass,
                  ...(command.agent !== undefined ? { agentOverride: command.agent } : {}),
                },
              ])

              yield* Queue.offer(loop.steerQueue, {
                _tag: "Interrupt",
                sessionId: command.sessionId,
                branchId: command.branchId,
              })
            }),

          followUp: (message) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(message.sessionId, message.branchId)
              const queue = yield* Ref.get(loop.followUpQueue)
              if (queue.length >= DEFAULTS.followUpQueueMax) {
                return yield* new AgentLoopError({
                  message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                })
              }
              const session = yield* storage
                .getSession(message.sessionId)
                .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
              const bypass = session?.bypass ?? true
              yield* Ref.update(loop.followUpQueue, (items) =>
                appendFollowUpItem(items, { message, bypass }),
              )
            }),

          drainQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return { steering: [], followUp: [] }
              }

              const steeringItems = yield* Ref.get(loop.steeringMessageQueue)
              const followUpItems = yield* Ref.get(loop.followUpQueue)
              yield* Ref.set(loop.steeringMessageQueue, [])
              yield* Ref.set(loop.followUpQueue, [])

              return {
                steering: steeringItems.map((item) => messageText(item.message)).filter(Boolean),
                followUp: followUpItems.map((item) => messageText(item.message)).filter(Boolean),
              }
            }),

          getQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return { steering: [], followUp: [] }
              }

              const steeringItems = yield* Ref.get(loop.steeringMessageQueue)
              const followUpItems = yield* Ref.get(loop.followUpQueue)

              return {
                steering: steeringItems.map((item) => messageText(item.message)).filter(Boolean),
                followUp: followUpItems.map((item) => messageText(item.message)).filter(Boolean),
              }
            }),

          isRunning: (input) =>
            Effect.gen(function* () {
              const loop = yield* findLoop(input.sessionId, input.branchId)
              if (loop === undefined) return false
              return yield* loop.actor.matches("Running")
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
          const services = yield* Effect.services<never>()
          const runFork = Effect.runForkWith(services)
          const inspector = makeInspector<typeof AgentActorState, typeof AgentActorEvent>(
            (event) => {
              runFork(
                eventStore
                  .publish(
                    new MachineInspected({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      actorId: event.actorId,
                      inspectionType: event.type,
                      payload: event,
                    }),
                  )
                  .pipe(
                    Effect.catchEager((e) =>
                      Effect.logWarning("failed to publish MachineInspected", e),
                    ),
                  ),
              )
            },
          )

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
