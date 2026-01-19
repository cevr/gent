import { Context, DateTime, Effect, Layer, Ref, Runtime, Schema, Stream, Queue } from "effect"
import {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  EventBus,
  StreamStarted,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  ToolCallStarted,
  ToolCallCompleted,
  MessageReceived,
  ToolRegistry,
  ToolContext,
  Permission,
  ErrorOccurred,
} from "@gent/core"
import { Storage, StorageError } from "@gent/storage"
import { Provider, ProviderError, FinishChunk } from "@gent/providers"
import { withRetry } from "./retry.js"

// Summarize tool output for display (first line, truncated)
function summarizeToolOutput(result: ToolResultPart): string {
  const value = result.output.value
  if (typeof value === "string") {
    const firstLine = value.split("\n")[0] ?? ""
    return firstLine.length > 100 ? firstLine.slice(0, 100) + "..." : firstLine
  }
  if (value && typeof value === "object") {
    const str = JSON.stringify(value)
    return str.length > 100 ? str.slice(0, 100) + "..." : str
  }
  return String(value)
}

// Agent Loop Error

export class AgentLoopError extends Schema.TaggedError<AgentLoopError>()(
  "AgentLoopError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

// Steer Command

export const SteerCommand = Schema.Union(
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("Interrupt", { message: Schema.String }),
  Schema.TaggedStruct("SwitchModel", { model: Schema.String })
)
export type SteerCommand = typeof SteerCommand.Type

// Agent Loop State

interface AgentLoopState {
  running: boolean
  model: string
  followUpQueue: Message[]
}

// Agent Loop Service

export interface AgentLoopService {
  readonly run: (message: Message) => Effect.Effect<void, AgentLoopError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void>
  readonly followUp: (message: Message) => Effect.Effect<void>
  readonly isRunning: () => Effect.Effect<boolean>
}

export class AgentLoop extends Context.Tag("AgentLoop")<
  AgentLoop,
  AgentLoopService
>() {
  static Live = (config: {
    systemPrompt: string
    defaultModel: string
  }): Layer.Layer<
    AgentLoop,
    never,
    Storage | Provider | ToolRegistry | EventBus | Permission
  > =>
    Layer.scoped(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const provider = yield* Provider
        const toolRegistry = yield* ToolRegistry
        const eventBus = yield* EventBus
        const permission = yield* Permission
        const runtime = yield* Effect.runtime<never>()

        const stateRef = yield* Ref.make<AgentLoopState>({
          running: false,
          model: config.defaultModel,
          followUpQueue: [],
        })

        const steerQueue = yield* Queue.unbounded<SteerCommand>()

        const executeToolCall = Effect.fn("AgentLoop.executeToolCall")(
          function* (toolCall: ToolCallPart, ctx: ToolContext) {
            const tool = yield* toolRegistry.get(toolCall.toolName)

            if (!tool) {
              return new ToolResultPart({
                type: "tool-result",
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                output: { type: "error-json", value: { error: `Unknown tool: ${toolCall.toolName}` } },
              })
            }

            // Check permission
            const permResult = yield* permission.check(
              toolCall.toolName,
              toolCall.input
            )

            if (permResult === "denied") {
              return new ToolResultPart({
                type: "tool-result",
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                output: { type: "error-json", value: { error: "Permission denied" } },
              })
            }

            // Decode input using tool's params schema
            const decodedInput = yield* Effect.try({
              // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- tool.params is AnyToolDefinition with any schema type
              try: () => Schema.decodeUnknownSync(tool.params)(toolCall.input),
              catch: (e) => new AgentLoopError({
                message: `Invalid tool input: ${e instanceof Error ? e.message : String(e)}`,
                cause: e,
              }),
            })

            // Execute tool using runtime
            const result = yield* Effect.tryPromise({
              try: () => {
                const effect = tool.execute(decodedInput, ctx)
                return Runtime.runPromise(runtime)(
                  effect as Effect.Effect<unknown>
                )
              },
              catch: (e) =>
                new AgentLoopError({
                  message: `Tool execution failed: ${e}`,
                  cause: e,
                }),
            })

            return new ToolResultPart({
              type: "tool-result",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: { type: "json", value: result },
            })
          }
        )

        const runLoop: (
          sessionId: string,
          branchId: string,
          initialMessage: Message
        ) => Effect.Effect<void, AgentLoopError | StorageError | ProviderError> = Effect.fn("AgentLoop.runLoop")(function* (
          sessionId: string,
          branchId: string,
          initialMessage: Message
        ) {
          // Save user message
          yield* storage.createMessage(initialMessage)
          yield* eventBus.publish(
            new MessageReceived({
              sessionId,
              branchId,
              messageId: initialMessage.id,
              role: "user",
            })
          )

          // Track turn start time
          const turnStartTime = yield* DateTime.now

          let continueLoop = true

          while (continueLoop) {
            // Check for steer commands
            const steerCmd = yield* Queue.poll(steerQueue)
            if (steerCmd._tag === "Some") {
              const cmd = steerCmd.value
              if (cmd._tag === "Cancel") {
                continueLoop = false
                break
              } else if (cmd._tag === "SwitchModel") {
                yield* Ref.update(stateRef, (s) => ({
                  ...s,
                  model: cmd.model,
                }))
              }
            }

            const state = yield* Ref.get(stateRef)
            const messages = yield* storage.listMessages(branchId)
            const tools = yield* toolRegistry.list()

            // Start streaming
            yield* eventBus.publish(new StreamStarted({ sessionId, branchId }))

            const streamEffect = yield* withRetry(
              provider.stream({
                model: state.model,
                messages: [...messages],
                tools: [...tools],
                systemPrompt: config.systemPrompt,
              })
            ).pipe(Effect.withSpan("AgentLoop.provider.stream"))

            // Collect response parts
            const textParts: string[] = []
            const toolCalls: ToolCallPart[] = []
            let lastFinishChunk: FinishChunk | undefined

            yield* Stream.runForEach(streamEffect, (chunk) =>
              Effect.gen(function* () {
                if (chunk._tag === "TextChunk") {
                  textParts.push(chunk.text)
                  yield* eventBus.publish(
                    new EventStreamChunk({
                      sessionId,
                      branchId,
                      chunk: chunk.text,
                    })
                  )
                } else if (chunk._tag === "ToolCallChunk") {
                  toolCalls.push(
                    new ToolCallPart({
                      type: "tool-call",
                      toolCallId: chunk.toolCallId,
                      toolName: chunk.toolName,
                      input: chunk.input,
                    })
                  )
                } else if (chunk._tag === "FinishChunk") {
                  lastFinishChunk = chunk
                }
              })
            )

            yield* eventBus.publish(
              new StreamEnded({
                sessionId,
                branchId,
                usage: lastFinishChunk?.usage,
              })
            )

            // Build assistant message
            const assistantParts: Array<TextPart | ToolCallPart> = []
            const fullText = textParts.join("")
            if (fullText) {
              assistantParts.push(new TextPart({ type: "text", text: fullText }))
            }
            assistantParts.push(...toolCalls)

            const assistantMessage = new Message({
              id: crypto.randomUUID(),
              sessionId,
              branchId,
              role: "assistant",
              parts: assistantParts,
              createdAt: new Date(),
            })

            yield* storage.createMessage(assistantMessage)
            yield* eventBus.publish(
              new MessageReceived({
                sessionId,
                branchId,
                messageId: assistantMessage.id,
                role: "assistant",
              })
            )

            // Execute tool calls if any
            if (toolCalls.length > 0) {
              const toolResults: ToolResultPart[] = []

              for (const toolCall of toolCalls) {
                yield* eventBus.publish(
                  new ToolCallStarted({
                    sessionId,
                    branchId,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    input: toolCall.input,
                  })
                )

                const result = yield* executeToolCall(toolCall, {
                  sessionId,
                  branchId,
                  toolCallId: toolCall.toolCallId,
                })

                toolResults.push(result)

                // Extract output summary for display
                const outputSummary = summarizeToolOutput(result)

                yield* eventBus.publish(
                  new ToolCallCompleted({
                    sessionId,
                    branchId,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    isError: result.output.type === "error-json",
                    output: outputSummary,
                  })
                )
              }

              // Create tool result message
              const toolResultMessage = new Message({
                id: crypto.randomUUID(),
                sessionId,
                branchId,
                role: "tool",
                parts: toolResults,
                createdAt: new Date(),
              })

              yield* storage.createMessage(toolResultMessage)

              // Continue loop to process tool results
              continueLoop = true
            } else {
              // No tool calls, loop ends
              continueLoop = false
            }
          }

          // Update user message with turn duration
          const turnEndTime = yield* DateTime.now
          const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - DateTime.toEpochMillis(turnStartTime)
          yield* storage.updateMessageTurnDuration(initialMessage.id, turnDurationMs)

          // Process follow-up queue
          const finalState = yield* Ref.get(stateRef)
          if (finalState.followUpQueue.length > 0) {
            const nextMessage = finalState.followUpQueue[0]!
            yield* Ref.update(stateRef, (s) => ({
              ...s,
              followUpQueue: s.followUpQueue.slice(1),
            }))
            yield* runLoop(sessionId, branchId, nextMessage)
          }
        })

        const service: AgentLoopService = {
          run: Effect.fn("AgentLoop.run")(function* (message: Message) {
            const isRunning = yield* Ref.get(stateRef).pipe(
              Effect.map((s) => s.running)
            )

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
              runLoop(
                message.sessionId,
                message.branchId,
                message
              ) as Effect.Effect<void, AgentLoopError | StorageError | ProviderError>
            ).pipe(
              Effect.withSpan("AgentLoop.run"),
              Effect.catchAll((e) =>
                eventBus.publish(
                  new ErrorOccurred({
                    sessionId: message.sessionId,
                    branchId: message.branchId,
                    error: "message" in e ? e.message : String(e),
                  })
                )
              ),
              Effect.ensuring(
                Ref.update(stateRef, (s) => ({ ...s, running: false }))
              )
            )
          }),

          steer: (command) => Queue.offer(steerQueue, command),

          followUp: (message) =>
            Ref.update(stateRef, (s) => ({
              ...s,
              followUpQueue: [...s.followUpQueue, message],
            })),

          isRunning: () => Ref.get(stateRef).pipe(Effect.map((s) => s.running)),
        }

        return service
      })
    )

  static Test = (): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      isRunning: () => Effect.succeed(false),
    })
}
