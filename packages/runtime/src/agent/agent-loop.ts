import {
  Cause,
  ServiceMap,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
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
  AgentName,
  AgentRegistry,
  resolveAgentModelId,
  SubagentError,
  type AgentDefinition,
  type AgentName as AgentNameType,
} from "@gent/core/domain/agent.js"
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
  MachineInspected,
  MachineTaskFailed,
  MachineTaskSucceeded,
  type AgentEvent,
  type EventStoreError,
} from "@gent/core/domain/event.js"
import { Message, TextPart, ReasoningPart, ToolCallPart } from "@gent/core/domain/message.js"
import { SessionId, BranchId, type MessageId } from "@gent/core/domain/ids.js"
import { ToolRegistry, type ToolContext } from "@gent/core/domain/tool.js"
import { summarizeToolOutput, stringifyOutput } from "@gent/core/domain/tool-output.js"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers.js"
import { DEFAULTS } from "@gent/core/domain/defaults.js"
import { Storage, type StorageError } from "@gent/core/storage/sqlite-storage.js"
import {
  Provider,
  type ProviderError,
  type FinishChunk,
  type ProviderRequest,
} from "@gent/core/providers/provider.js"
import { withRetry } from "../retry"
import { CheckpointService } from "../checkpoint"
import { ToolRunner } from "./tool-runner"

// Agent Loop Error

const buildSystemPrompt = (
  basePrompt: string,
  agent: AgentDefinition,
  contextPrefix?: string,
): string => {
  const parts: string[] = []
  if (contextPrefix !== undefined && contextPrefix !== "") parts.push(contextPrefix)
  parts.push(basePrompt)

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
  Schema.TaggedStruct("Interject", { ...SteerTargetFields, message: Schema.String }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerCommand = typeof SteerCommand.Type

// Agent Loop Context

type FollowUpItem = {
  message: Message
  bypass: boolean
}

type LoopActor = ActorRef<typeof AgentLoopState.Type, typeof AgentLoopEvent.Type>

type SemaphoreType = Semaphore.Semaphore

type LoopHandle = {
  actor: LoopActor
  steerQueue: Queue.Queue<SteerCommand>
  pendingSteerRef: Ref.Ref<SteerCommand[]>
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
    | Storage
    | Provider
    | ToolRegistry
    | AgentRegistry
    | EventStore
    | CheckpointService
    | HandoffHandler
    | FileSystem.FileSystem
    | ToolRunner
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const provider = yield* Provider
        const toolRegistry = yield* ToolRegistry
        const agentRegistry = yield* AgentRegistry
        const eventStore = yield* EventStore
        const checkpointService = yield* CheckpointService
        const handoffHandler = yield* HandoffHandler
        const fs = yield* FileSystem.FileSystem
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
              if (cmd._tag !== "SwitchAgent") return

              const previous = yield* resolveCurrentAgent()
              const next: AgentNameType = Schema.is(AgentName)(cmd.agent) ? cmd.agent : "cowork"
              const resolved = yield* agentRegistry.get(next)
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
            ) => Effect.Effect<
              boolean,
              AgentLoopError | StorageError | ProviderError | EventStoreError
            > = Effect.fn("AgentLoop.runLoop")(function* (
              initialMessage: Message,
              bypass: boolean,
            ) {
              const enqueueInterject = Effect.fn("AgentLoop.enqueueInterject")(function* (
                content: string,
                createdAt?: Date,
              ) {
                const interjectMsg = new Message({
                  id: Bun.randomUUIDv7() as MessageId,
                  sessionId,
                  branchId,
                  kind: "interjection",
                  role: "user",
                  parts: [new TextPart({ type: "text", text: content })],
                  createdAt: createdAt ?? new Date(),
                })
                yield* Ref.update(followUpQueue, (queue) => [
                  { message: interjectMsg, bypass },
                  ...queue,
                ])
              })

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
              let cachedCheckpointId: string | undefined
              let cachedContextPrefix = ""

              const appendCachedMessage = (message: Message) => {
                if (cachedMessages !== undefined) cachedMessages.push(message)
              }

              while (continueLoop) {
                yield* applyPendingSteerCommands()

                // Check for steer commands
                const steerCmd = yield* Queue.poll(steerQueue)
                if (steerCmd._tag === "Some") {
                  const cmd = steerCmd.value
                  if (cmd._tag === "Cancel") {
                    continueLoop = false
                    turnInterrupted = true
                    yield* publishEvent(
                      new StreamEnded({
                        sessionId,
                        branchId,
                        interrupted: true,
                      }),
                    )
                    break
                  } else if (cmd._tag === "Interrupt") {
                    // Hard stop - emit StreamEnded with interrupted flag
                    continueLoop = false
                    turnInterrupted = true
                    yield* publishEvent(
                      new StreamEnded({
                        sessionId,
                        branchId,
                        interrupted: true,
                      }),
                    )
                    break
                  } else if (cmd._tag === "Interject") {
                    // Seamless pivot - queue message for immediate processing
                    yield* enqueueInterject(cmd.message)
                    continueLoop = false
                    break
                  } else if (cmd._tag === "SwitchAgent") {
                    yield* applySteerCommand(cmd)
                  }
                }

                const currentAgent = yield* resolveCurrentAgent()

                // Checkpoint-aware message loading
                const checkpoint = yield* checkpointService.getLatestCheckpoint(branchId)
                const checkpointId = checkpoint?.id ?? "none"
                const { messages, contextPrefix } = yield* Effect.gen(function* () {
                  if (cachedMessages !== undefined && cachedCheckpointId === checkpointId) {
                    return {
                      messages: cachedMessages,
                      contextPrefix: cachedContextPrefix,
                    }
                  }
                  if (checkpoint === undefined) {
                    const loaded = yield* storage.listMessages(branchId)
                    cachedMessages = [...loaded]
                    cachedContextPrefix = ""
                    cachedCheckpointId = checkpointId
                    return { messages: cachedMessages, contextPrefix: cachedContextPrefix }
                  }
                  if (checkpoint._tag === "PlanCheckpoint") {
                    const planContent = yield* fs
                      .readFileString(checkpoint.planPath)
                      .pipe(Effect.catchEager(() => Effect.succeed("")))
                    const loaded = yield* storage.listMessagesSince(branchId, checkpoint.createdAt)
                    cachedMessages = [...loaded]
                    cachedContextPrefix =
                      planContent !== "" ? `Plan to execute:\n${planContent}\n\n` : ""
                    cachedCheckpointId = checkpointId
                    return { messages: cachedMessages, contextPrefix: cachedContextPrefix }
                  }
                  const loaded = yield* storage.listMessagesAfter(
                    branchId,
                    checkpoint.firstKeptMessageId,
                  )
                  cachedMessages = [...loaded]
                  cachedContextPrefix =
                    checkpoint.summary !== undefined && checkpoint.summary !== ""
                      ? `Previous context:\n${checkpoint.summary}\n\n`
                      : ""
                  cachedCheckpointId = checkpointId
                  return { messages: cachedMessages, contextPrefix: cachedContextPrefix }
                })

                const agent = yield* agentRegistry.get(currentAgent)
                if (agent === undefined) {
                  yield* publishEvent(
                    new ErrorOccurred({
                      sessionId,
                      branchId,
                      error: `Unknown agent: ${currentAgent}`,
                    }),
                  )
                  return interrupted
                }

                const allTools = yield* toolRegistry.list()
                const tools = allTools.filter((tool) => {
                  if (agent.allowedTools !== undefined && !agent.allowedTools.includes(tool.name)) {
                    return false
                  }
                  if (agent.deniedTools !== undefined && agent.deniedTools.includes(tool.name)) {
                    return false
                  }
                  return true
                })

                const systemPrompt = buildSystemPrompt(config.systemPrompt, agent, contextPrefix)

                // Start streaming
                yield* publishEvent(new StreamStarted({ sessionId, branchId }))
                yield* Effect.logInfo("stream.start").pipe(
                  Effect.annotateLogs({
                    agent: currentAgent,
                    model: resolveAgentModelId(agent.name),
                  }),
                )

                const modelId = resolveAgentModelId(agent.name)
                const session = yield* storage
                  .getSession(sessionId)
                  .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
                const reasoning = resolveReasoning(agent, session?.reasoningLevel)
                const abortController = new AbortController()
                const streamEffect = yield* withRetry(
                  provider.stream({
                    model: modelId,
                    messages: [...messages],
                    tools: [...tools],
                    systemPrompt,
                    abortSignal: abortController.signal,
                    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
                    ...(reasoning !== undefined ? { reasoning } : {}),
                  }),
                ).pipe(Effect.withSpan("AgentLoop.provider.stream"))

                // Collect response parts
                const textParts: string[] = []
                const reasoningParts: string[] = []
                const toolCalls: ToolCallPart[] = []
                let lastFinishChunk: FinishChunk | undefined

                const interruptRef = yield* Ref.make<SteerCommand | null>(null)
                const interruptSignal = Effect.gen(function* () {
                  while (true) {
                    const cmd = yield* Queue.take(steerQueue)
                    if (
                      cmd._tag === "Cancel" ||
                      cmd._tag === "Interrupt" ||
                      cmd._tag === "Interject"
                    ) {
                      yield* Ref.set(interruptRef, cmd)
                      abortController.abort()
                      return
                    }
                    yield* Ref.update(pendingSteerRef, (pending) => [...pending, cmd])
                  }
                })

                const streamFailed = yield* Stream.runForEach(
                  streamEffect.pipe(Stream.interruptWhen(interruptSignal)),
                  (chunk) =>
                    Effect.gen(function* () {
                      if (chunk._tag === "TextChunk") {
                        textParts.push(chunk.text)
                        yield* publishEvent(
                          new EventStreamChunk({
                            sessionId,
                            branchId,
                            chunk: chunk.text,
                          }),
                        )
                      } else if (chunk._tag === "ReasoningChunk") {
                        reasoningParts.push(chunk.text)
                      } else if (chunk._tag === "ToolCallChunk") {
                        toolCalls.push(
                          new ToolCallPart({
                            type: "tool-call",
                            toolCallId: chunk.toolCallId,
                            toolName: chunk.toolName,
                            input: chunk.input,
                          }),
                        )
                      } else if (chunk._tag === "FinishChunk") {
                        lastFinishChunk = chunk
                      }
                    }),
                ).pipe(
                  Effect.as(false),
                  Effect.catchEager((streamError) =>
                    // Stream error (timeout, provider error) — persist any partial output
                    Effect.gen(function* () {
                      yield* Effect.logWarning(
                        "stream error, persisting partial output",
                        streamError,
                      )
                      const partialText = textParts.join("")
                      const partialReasoning = reasoningParts.join("")
                      if (partialText !== "" || partialReasoning !== "") {
                        const parts: Array<TextPart | ReasoningPart> = []
                        if (partialReasoning !== "") {
                          parts.push(
                            new ReasoningPart({ type: "reasoning", text: partialReasoning }),
                          )
                        }
                        if (partialText !== "") {
                          parts.push(new TextPart({ type: "text", text: partialText }))
                        }
                        const partialMessage = new Message({
                          id: Bun.randomUUIDv7() as MessageId,
                          sessionId,
                          branchId,
                          role: "assistant",
                          parts,
                          createdAt: new Date(),
                        })
                        yield* storage.createMessage(partialMessage)
                        appendCachedMessage(partialMessage)
                        yield* publishEvent(
                          new MessageReceived({
                            sessionId,
                            branchId,
                            messageId: partialMessage.id,
                            role: "assistant",
                          }),
                        )
                      }
                      yield* publishEvent(
                        new StreamEnded({ sessionId, branchId, interrupted: true }),
                      )
                      return true
                    }),
                  ),
                )

                if (streamFailed) {
                  turnInterrupted = true
                  continueLoop = false
                  break
                }

                yield* applyPendingSteerCommands()
                const interruptCmd = yield* Ref.get(interruptRef)
                if (interruptCmd !== null) {
                  turnInterrupted = true
                  yield* publishEvent(
                    new StreamEnded({
                      sessionId,
                      branchId,
                      interrupted: true,
                    }),
                  )

                  const partialText = textParts.join("")
                  const partialReasoning = reasoningParts.join("")
                  let assistantCreatedAtMs: number | null = null
                  if (partialText !== "" || partialReasoning !== "") {
                    const createdAt = new Date()
                    assistantCreatedAtMs = createdAt.getTime()
                    const parts: Array<TextPart | ReasoningPart> = []
                    if (partialReasoning !== "") {
                      parts.push(new ReasoningPart({ type: "reasoning", text: partialReasoning }))
                    }
                    if (partialText !== "") {
                      parts.push(new TextPart({ type: "text", text: partialText }))
                    }
                    const assistantMessage = new Message({
                      id: Bun.randomUUIDv7() as MessageId,
                      sessionId,
                      branchId,
                      role: "assistant",
                      parts,
                      createdAt,
                    })

                    yield* storage.createMessage(assistantMessage)
                    appendCachedMessage(assistantMessage)
                    yield* publishEvent(
                      new MessageReceived({
                        sessionId,
                        branchId,
                        messageId: assistantMessage.id,
                        role: "assistant",
                      }),
                    )
                  }

                  if (interruptCmd._tag === "Interject") {
                    const createdAt =
                      assistantCreatedAtMs !== null
                        ? new Date(assistantCreatedAtMs + 1)
                        : new Date()
                    yield* enqueueInterject(interruptCmd.message, createdAt)
                  }

                  continueLoop = false
                  break
                }

                yield* publishEvent(
                  new StreamEnded({
                    sessionId,
                    branchId,
                    usage: lastFinishChunk?.usage,
                  }),
                )
                yield* Effect.logInfo("stream.end").pipe(
                  Effect.annotateLogs({
                    inputTokens: lastFinishChunk?.usage?.inputTokens ?? 0,
                    outputTokens: lastFinishChunk?.usage?.outputTokens ?? 0,
                    toolCallCount: toolCalls.length,
                  }),
                )

                // Build assistant message
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
                  sessionId,
                  branchId,
                  role: "assistant",
                  parts: assistantParts,
                  createdAt: new Date(),
                })

                yield* storage.createMessage(assistantMessage)
                appendCachedMessage(assistantMessage)
                yield* publishEvent(
                  new MessageReceived({
                    sessionId,
                    branchId,
                    messageId: assistantMessage.id,
                    role: "assistant",
                  }),
                )

                // Execute tool calls if any
                if (toolCalls.length > 0) {
                  const toolResults = yield* Effect.forEach(
                    toolCalls,
                    (toolCall) =>
                      Effect.gen(function* () {
                        yield* publishEvent(
                          new ToolCallStarted({
                            sessionId,
                            branchId,
                            toolCallId: toolCall.toolCallId,
                            toolName: toolCall.toolName,
                            input: toolCall.input,
                          }),
                        )

                        const ctx: ToolContext = {
                          sessionId,
                          branchId,
                          toolCallId: toolCall.toolCallId,
                          agentName: currentAgent,
                        }
                        const run = toolRunner.run(toolCall, ctx, { bypass })
                        const tool = yield* toolRegistry.get(toolCall.toolName)
                        const result = yield* tool?.concurrency === "serial"
                          ? bashSemaphore.withPermits(1)(run)
                          : run

                        const outputSummary = summarizeToolOutput(result)
                        const isError = result.output.type === "error-json"
                        const toolCallFields = {
                          sessionId,
                          branchId,
                          toolCallId: toolCall.toolCallId,
                          toolName: toolCall.toolName,
                          summary: outputSummary,
                          output: stringifyOutput(result.output.value),
                        }
                        yield* publishEvent(
                          isError
                            ? new ToolCallFailed(toolCallFields)
                            : new ToolCallSucceeded(toolCallFields),
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

                  // Create tool result message
                  const toolResultMessage = new Message({
                    id: Bun.randomUUIDv7() as MessageId,
                    sessionId,
                    branchId,
                    role: "tool",
                    parts: toolResults,
                    createdAt: new Date(),
                  })

                  yield* storage.createMessage(toolResultMessage)
                  appendCachedMessage(toolResultMessage)

                  // Continue loop to process tool results
                  continueLoop = true
                } else {
                  // No tool calls, loop ends
                  continueLoop = false
                }
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

              // Auto-handoff on context pressure (after turn completes, before next turn)
              if (!turnInterrupted) {
                const suppressLeft = yield* Ref.get(handoffSuppressRef)
                if (suppressLeft > 0) {
                  yield* Ref.update(handoffSuppressRef, (n) => n - 1)
                } else {
                  const allMessages = yield* storage.listMessages(branchId)
                  const currentAgent = yield* resolveCurrentAgent()
                  const modelId = resolveAgentModelId(currentAgent)
                  const contextPercent = yield* checkpointService.estimateContextPercent(
                    allMessages,
                    modelId,
                  )
                  if (contextPercent >= DEFAULTS.handoffThresholdPercent) {
                    yield* Effect.logInfo("auto-handoff.threshold").pipe(
                      Effect.annotateLogs({
                        contextPercent,
                        threshold: DEFAULTS.handoffThresholdPercent,
                      }),
                    )
                    // Build summary from recent messages
                    const recentText = allMessages
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
                    const summary =
                      recentText.length > 0 ? recentText.slice(0, 4000) : "Session context"

                    const decision = yield* handoffHandler
                      .present({
                        sessionId,
                        branchId,
                        summary,
                        reason: `Context at ${contextPercent}% (threshold: ${DEFAULTS.handoffThresholdPercent}%)`,
                      })
                      .pipe(Effect.catchEager(() => Effect.succeed("reject" as const)))

                    if (decision === "reject") {
                      // Suppress for 5 more turns
                      yield* Ref.set(handoffSuppressRef, 5)
                    }
                  }
                }
              }

              // Process follow-up queue
              const queue = yield* Ref.get(followUpQueue)
              const nextItem = queue[0]
              if (nextItem !== undefined) {
                yield* Ref.update(followUpQueue, (items) => items.slice(1))
                const nextInterrupted = yield* runLoop(nextItem.message, nextItem.bypass)
                interrupted = interrupted || nextInterrupted
              }

              return interrupted
            })

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
                  runLoop(state.message, state.bypass).pipe(
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
              yield* Ref.update(loop.followUpQueue, (queue) => [...queue, { message, bypass }])
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
            getLoop(command.sessionId, command.branchId).pipe(
              Effect.flatMap((loop) => Queue.offer(loop.steerQueue, command)),
            ),

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
              yield* Ref.update(loop.followUpQueue, (items) => [...items, { message, bypass }])
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
    Storage | Provider | ToolRegistry | EventStore | AgentRegistry | ToolRunner
  > = Layer.effect(
    AgentActor,
    Effect.gen(function* () {
      const storage = yield* Storage
      const provider = yield* Provider
      const toolRegistry = yield* ToolRegistry
      const eventStore = yield* EventStore
      const agentRegistry = yield* AgentRegistry
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
          const agent = yield* agentRegistry.get(input.agentName)
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

          const basePrompt = buildSystemPrompt(input.systemPrompt, agent)

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

          const allTools = yield* toolRegistry.list()
          const tools = allTools.filter((tool) => {
            if (agent.allowedTools !== undefined && !agent.allowedTools.includes(tool.name)) {
              return false
            }
            if (agent.deniedTools !== undefined && agent.deniedTools.includes(tool.name)) {
              return false
            }
            return true
          })

          const messages: Message[] = [userMessage]
          let continueLoop = true

          while (continueLoop) {
            yield* eventStore.publish(
              new StreamStarted({ sessionId: input.sessionId, branchId: input.branchId }),
            )

            const modelId = resolveAgentModelId(agent.name)
            const reasoning = resolveReasoning(agent)
            const streamEffect = yield* withRetry(
              provider.stream({
                model: modelId,
                messages: [...messages],
                tools: [...tools],
                systemPrompt: basePrompt,
                ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
                ...(reasoning !== undefined ? { reasoning } : {}),
              }),
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

                    const tool = yield* toolRegistry.get(toolCall.toolName)
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
