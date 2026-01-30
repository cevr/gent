import { Context, DateTime, Effect, Layer, Ref, Schema, Stream, Queue } from "effect"
import type {
  AgentEvent,
  EventStoreError,
  ToolContext,
  AgentName as AgentNameType,
} from "@gent/core"
import {
  AgentName,
  AgentRegistry,
  AgentSwitched,
  Message,
  TextPart,
  ToolCallPart,
  EventStore,
  StreamStarted,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  TurnCompleted,
  ToolCallStarted,
  ToolCallCompleted,
  MessageReceived,
  ToolRegistry,
  ErrorOccurred,
  DEFAULTS,
  summarizeToolOutput,
  stringifyOutput,
} from "@gent/core"
import type { StorageError } from "@gent/storage"
import { Storage } from "@gent/storage"
import type { ProviderError, FinishChunk } from "@gent/providers"
import { Provider } from "@gent/providers"
import { withRetry } from "../retry"
import { CheckpointService } from "../checkpoint"
import { FileSystem } from "@effect/platform"
import { buildSystemPrompt } from "./system-prompt"
import { ToolRunner } from "./tool-runner"

// Agent Loop Error

export class AgentLoopError extends Schema.TaggedError<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Steer Command

export const SteerCommand = Schema.Union(
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("Interrupt", {}),
  Schema.TaggedStruct("Interject", { message: Schema.String }),
  Schema.TaggedStruct("SwitchModel", { model: Schema.String }),
  Schema.TaggedStruct("SwitchAgent", { agent: AgentName }),
)
export type SteerCommand = typeof SteerCommand.Type

// Agent Loop State

interface AgentLoopState {
  running: boolean
  model: string
  currentAgent: AgentNameType
  followUpQueue: Message[]
}

// Agent Loop Service

export interface AgentLoopService {
  readonly run: (
    message: Message,
    options?: { bypass?: boolean },
  ) => Effect.Effect<void, AgentLoopError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void>
  readonly followUp: (message: Message) => Effect.Effect<void, AgentLoopError>
  readonly isRunning: () => Effect.Effect<boolean>
}

export class AgentLoop extends Context.Tag("@gent/runtime/src/agent/agent-loop/AgentLoop")<
  AgentLoop,
  AgentLoopService
>() {
  static Live = (config: {
    systemPrompt: string
    defaultModel: string
    defaultAgent?: AgentName
  }): Layer.Layer<
    AgentLoop,
    never,
    | Storage
    | Provider
    | ToolRegistry
    | AgentRegistry
    | EventStore
    | CheckpointService
    | FileSystem.FileSystem
    | ToolRunner
  > =>
    Layer.scoped(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const provider = yield* Provider
        const toolRegistry = yield* ToolRegistry
        const agentRegistry = yield* AgentRegistry
        const eventStore = yield* EventStore
        const checkpointService = yield* CheckpointService
        const fs = yield* FileSystem.FileSystem
        const toolRunner = yield* ToolRunner
        const serialSemaphore = yield* Effect.makeSemaphore(1)

        const stateRef = yield* Ref.make<AgentLoopState>({
          running: false,
          model: config.defaultModel,
          currentAgent: config.defaultAgent ?? "default",
          followUpQueue: [],
        })

        const steerQueue = yield* Queue.unbounded<SteerCommand>()
        const pendingSteerRef = yield* Ref.make<SteerCommand[]>([])
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

        const applySteerCommand = Effect.fn("AgentLoop.applySteerCommand")(function* (
          sessionId: string,
          branchId: string,
          cmd: SteerCommand,
        ) {
          if (cmd._tag === "SwitchModel") {
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              model: cmd.model,
            }))
            return
          }

          if (cmd._tag !== "SwitchAgent") return

          const previous = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.currentAgent))
          const next = cmd.agent as AgentName
          const resolved = yield* agentRegistry.get(next)
          if (resolved === undefined) return

          yield* Ref.update(stateRef, (s) => ({
            ...s,
            currentAgent: next,
          }))

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
          function* (sessionId: string, branchId: string) {
            const pending = yield* Ref.getAndSet(pendingSteerRef, [])
            if (pending.length === 0) return
            for (const cmd of pending) {
              yield* applySteerCommand(sessionId, branchId, cmd)
            }
          },
        )

        const runLoop: (
          sessionId: string,
          branchId: string,
          initialMessage: Message,
          bypass: boolean,
        ) => Effect.Effect<void, AgentLoopError | StorageError | ProviderError | EventStoreError> =
          Effect.fn("AgentLoop.runLoop")(function* (
            sessionId: string,
            branchId: string,
            initialMessage: Message,
            bypass: boolean,
          ) {
            const enqueueInterject = Effect.fn("AgentLoop.enqueueInterject")(function* (
              content: string,
              createdAt?: Date,
            ) {
              const interjectMsg = new Message({
                id: Bun.randomUUIDv7(),
                sessionId,
                branchId,
                kind: "interjection",
                role: "user",
                parts: [new TextPart({ type: "text", text: content })],
                createdAt: createdAt ?? new Date(),
              })
              yield* Ref.update(stateRef, (s) => ({
                ...s,
                followUpQueue: [interjectMsg, ...s.followUpQueue],
              }))
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

            // Track turn start time and interruption state
            const turnStartTime = yield* DateTime.now
            let turnInterrupted = false

            let continueLoop = true
            let cachedMessages: Message[] | undefined
            let cachedCheckpointId: string | undefined
            let cachedContextPrefix = ""

            const appendCachedMessage = (message: Message) => {
              if (cachedMessages !== undefined) cachedMessages.push(message)
            }

            while (continueLoop) {
              yield* applyPendingSteerCommands(sessionId, branchId)

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
                } else if (cmd._tag === "SwitchModel") {
                  yield* applySteerCommand(sessionId, branchId, cmd)
                } else if (cmd._tag === "SwitchAgent") {
                  yield* applySteerCommand(sessionId, branchId, cmd)
                }
              }

              const state = yield* Ref.get(stateRef)

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
                    .pipe(Effect.catchAll(() => Effect.succeed("")))
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

              const agent = yield* agentRegistry.get(state.currentAgent)
              if (agent === undefined) {
                yield* publishEvent(
                  new ErrorOccurred({
                    sessionId,
                    branchId,
                    error: `Unknown agent: ${state.currentAgent}`,
                  }),
                )
                return
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

              const streamEffect = yield* withRetry(
                provider.stream({
                  model: agent.preferredModel ?? state.model,
                  messages: [...messages],
                  tools: [...tools],
                  systemPrompt,
                  ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
                }),
              ).pipe(Effect.withSpan("AgentLoop.provider.stream"))

              // Collect response parts
              const textParts: string[] = []
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
                    return
                  }
                  yield* Ref.update(pendingSteerRef, (pending) => [...pending, cmd])
                }
              })

              yield* Stream.runForEach(
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
              )

              yield* applyPendingSteerCommands(sessionId, branchId)
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
                let assistantCreatedAtMs: number | null = null
                if (partialText !== "") {
                  const createdAt = new Date()
                  assistantCreatedAtMs = createdAt.getTime()
                  const assistantMessage = new Message({
                    id: Bun.randomUUIDv7(),
                    sessionId,
                    branchId,
                    role: "assistant",
                    parts: [new TextPart({ type: "text", text: partialText })],
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
                    assistantCreatedAtMs !== null ? new Date(assistantCreatedAtMs + 1) : new Date()
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

              // Build assistant message
              const assistantParts: Array<TextPart | ToolCallPart> = []
              const fullText = textParts.join("")
              if (fullText !== "") {
                assistantParts.push(new TextPart({ type: "text", text: fullText }))
              }
              assistantParts.push(...toolCalls)

              const assistantMessage = new Message({
                id: Bun.randomUUIDv7(),
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

                      const tool = yield* toolRegistry.get(toolCall.toolName)
                      const ctx: ToolContext = {
                        sessionId,
                        branchId,
                        toolCallId: toolCall.toolCallId,
                        agentName: state.currentAgent,
                      }
                      const run = toolRunner.run(toolCall, ctx, { bypass })
                      const result = yield* tool?.concurrency === "serial"
                        ? serialSemaphore.withPermits(1)(run)
                        : run

                      const outputSummary = summarizeToolOutput(result)
                      yield* publishEvent(
                        new ToolCallCompleted({
                          sessionId,
                          branchId,
                          toolCallId: toolCall.toolCallId,
                          toolName: toolCall.toolName,
                          isError: result.output.type === "error-json",
                          summary: outputSummary,
                          output: stringifyOutput(result.output.value),
                        }),
                      )

                      return result
                    }),
                  { concurrency: Math.max(1, DEFAULTS.toolConcurrency) },
                )

                // Create tool result message
                const toolResultMessage = new Message({
                  id: Bun.randomUUIDv7(),
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

            // Process follow-up queue
            const finalState = yield* Ref.get(stateRef)
            const nextMessage = finalState.followUpQueue[0]
            if (nextMessage !== undefined) {
              yield* Ref.update(stateRef, (s) => ({
                ...s,
                followUpQueue: s.followUpQueue.slice(1),
              }))
              yield* runLoop(sessionId, branchId, nextMessage, bypass)
            }
          })

        const service: AgentLoopService = {
          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: { bypass?: boolean },
          ) {
            const isRunning = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.running))
            const bypass = options?.bypass ?? true

            if (isRunning) {
              // Queue as follow-up
              yield* Ref.update(stateRef, (s) => ({
                ...s,
                followUpQueue: [...s.followUpQueue, message],
              }))
              return
            }

            yield* Ref.update(stateRef, (s) => ({ ...s, running: true }))

            yield* (
              runLoop(message.sessionId, message.branchId, message, bypass) as Effect.Effect<
                void,
                AgentLoopError | StorageError | ProviderError | EventStoreError
              >
            ).pipe(
              Effect.withSpan("AgentLoop.run"),
              Effect.catchAll((e) =>
                publishEvent(
                  new ErrorOccurred({
                    sessionId: message.sessionId,
                    branchId: message.branchId,
                    error: "message" in e ? e.message : String(e),
                  }),
                ),
              ),
              Effect.ensuring(Ref.update(stateRef, (s) => ({ ...s, running: false }))),
            )
          }),

          steer: (command) => Queue.offer(steerQueue, command),

          followUp: (message) =>
            Effect.gen(function* () {
              const state = yield* Ref.get(stateRef)
              if (state.followUpQueue.length >= DEFAULTS.followUpQueueMax) {
                return yield* new AgentLoopError({
                  message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                })
              }
              yield* Ref.update(stateRef, (s) => ({
                ...s,
                followUpQueue: [...s.followUpQueue, message],
              }))
            }),

          isRunning: () => Ref.get(stateRef).pipe(Effect.map((s) => s.running)),
        }

        return service
      }),
    )

  static Test = (): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
    })
}
