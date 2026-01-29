import { Cause, Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { Event, Machine, Slot, State } from "effect-machine"
import {
  AgentName,
  AgentRegistry,
  EventStore,
  ErrorOccurred,
  Message,
  MessageReceived,
  Permission,
  PermissionHandler,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  StreamStarted,
  TextPart,
  ToolCallCompleted,
  ToolCallPart,
  ToolCallStarted,
  ToolRegistry,
  ToolResultPart,
  SubagentError,
  type ToolDefinition,
} from "@gent/core"
import type { FinishChunk } from "@gent/providers"
import { Provider } from "@gent/providers"
import { Storage } from "@gent/storage"
import { withRetry } from "../retry"
import { buildSystemPrompt } from "./system-prompt"
import { summarizeToolOutput, stringifyOutput } from "./shared"

const AgentState = State({
  Idle: {},
  Running: {},
  Completed: {},
  Failed: { error: Schema.String },
})

const AgentRunInputFields = {
  sessionId: Schema.String,
  branchId: Schema.String,
  agentName: AgentName,
  prompt: Schema.String,
  defaultModel: Schema.String,
  systemPrompt: Schema.String,
  bypass: Schema.UndefinedOr(Schema.Boolean),
}

const AgentRunInputSchema = Schema.Struct(AgentRunInputFields)

export type AgentRunInput = typeof AgentRunInputSchema.Type

const AgentEvent = Event({
  Start: { input: AgentRunInputSchema },
})

const AgentEffects = Slot.Effects({
  run: AgentRunInputFields,
})

const AgentMachine = Machine.make({
  state: AgentState,
  event: AgentEvent,
  effects: AgentEffects,
  initial: AgentState.Idle,
})
  .on(AgentState.Idle, AgentEvent.Start, ({ event, effects }) =>
    Effect.gen(function* () {
      const exit = yield* effects.run(event.input).pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        const error = Cause.pretty(exit.cause)
        return AgentState.Failed({ error })
      }
      return AgentState.Completed
    }),
  )
  .final(AgentState.Completed)
  .final(AgentState.Failed)

export interface AgentActorService {
  readonly run: (input: AgentRunInput) => Effect.Effect<void, SubagentError>
}

export class AgentActor extends Context.Tag("@gent/runtime/src/agent/agent-actor/AgentActor")<
  AgentActor,
  AgentActorService
>() {
  static Live: Layer.Layer<
    AgentActor,
    never,
    Storage | Provider | ToolRegistry | EventStore | Permission | PermissionHandler | AgentRegistry
  > = Layer.effect(
    AgentActor,
    Effect.gen(function* () {
      const storage = yield* Storage
      const provider = yield* Provider
      const toolRegistry = yield* ToolRegistry
      const eventStore = yield* EventStore
      const permission = yield* Permission
      const permissionHandler = yield* PermissionHandler
      const agentRegistry = yield* AgentRegistry

      const runEffect: (input: AgentRunInput) => Effect.Effect<void, never> = (input) =>
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
            id: Bun.randomUUIDv7(),
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

          let continueLoop = true

          while (continueLoop) {
            const messages = yield* storage.listMessages(input.branchId)
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

            yield* eventStore.publish(
              new StreamStarted({ sessionId: input.sessionId, branchId: input.branchId }),
            )

            const streamEffect = yield* withRetry(
              provider.stream({
                model: agent.preferredModel ?? input.defaultModel,
                messages: [...messages],
                tools: [...tools],
                systemPrompt: basePrompt,
                ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
              }),
            ).pipe(Effect.withSpan("AgentActor.provider.stream"))

            const textParts: string[] = []
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

            yield* eventStore.publish(
              new StreamEnded({
                sessionId: input.sessionId,
                branchId: input.branchId,
                usage: lastFinishChunk?.usage,
              }),
            )

            const assistantParts: Array<TextPart | ToolCallPart> = []
            const fullText = textParts.join("")
            if (fullText !== "") {
              assistantParts.push(new TextPart({ type: "text", text: fullText }))
            }
            assistantParts.push(...toolCalls)

            const assistantMessage = new Message({
              id: Bun.randomUUIDv7(),
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
              const toolResults: ToolResultPart[] = []

              for (const toolCall of toolCalls) {
                yield* eventStore.publish(
                  new ToolCallStarted({
                    sessionId: input.sessionId,
                    branchId: input.branchId,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    input: toolCall.input,
                  }),
                )

                const result = yield* Effect.gen(function* () {
                  const tool = yield* toolRegistry.get(toolCall.toolName)
                  if (tool === undefined) {
                    return new ToolResultPart({
                      type: "tool-result",
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      output: {
                        type: "error-json",
                        value: { error: `Unknown tool: ${toolCall.toolName}` },
                      },
                    })
                  }

                  const permResult =
                    input.bypass === true
                      ? "allowed"
                      : yield* permission.check(toolCall.toolName, toolCall.input)

                  if (permResult === "denied") {
                    return new ToolResultPart({
                      type: "tool-result",
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      output: { type: "error-json", value: { error: "Permission denied" } },
                    })
                  }

                  if (permResult === "ask") {
                    const decision = yield* permissionHandler.request(
                      {
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        input: toolCall.input,
                      },
                      {
                        sessionId: input.sessionId,
                        branchId: input.branchId,
                        toolCallId: toolCall.toolCallId,
                        agentName: agent.name,
                      },
                    )

                    if (decision === "deny") {
                      return new ToolResultPart({
                        type: "tool-result",
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        output: {
                          type: "error-json",
                          value: { error: "Permission denied by user" },
                        },
                      })
                    }
                  }

                  const decodedInput = yield* Effect.try({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- tool.params is AnyToolDefinition with any schema type
                    try: () => Schema.decodeUnknownSync(tool.params)(toolCall.input),
                    catch: (e) =>
                      new SubagentError({
                        message: `Invalid tool input: ${String(e)}`,
                        cause: e,
                      }),
                  }).pipe(Effect.either)

                  if (decodedInput._tag === "Left") {
                    const error =
                      decodedInput.left instanceof Error
                        ? decodedInput.left.message
                        : String(decodedInput.left)
                    return new ToolResultPart({
                      type: "tool-result",
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      output: {
                        type: "error-json",
                        value: {
                          error: `Invalid tool input: ${error}`,
                        },
                      },
                    })
                  }

                  const toolDefinition = tool as ToolDefinition<
                    string,
                    Schema.Schema.AnyNoContext,
                    unknown,
                    unknown,
                    never
                  >
                  const result = yield* toolDefinition
                    .execute(decodedInput.right, {
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      toolCallId: toolCall.toolCallId,
                      agentName: agent.name,
                    })
                    .pipe(
                      Effect.mapError(
                        (e) => new SubagentError({ message: `Tool failed: ${String(e)}` }),
                      ),
                      Effect.either,
                    )

                  if (result._tag === "Left") {
                    return new ToolResultPart({
                      type: "tool-result",
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      output: {
                        type: "error-json",
                        value: { error: result.left.message },
                      },
                    })
                  }

                  return new ToolResultPart({
                    type: "tool-result",
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    output: { type: "json", value: result.right },
                  })
                })

                toolResults.push(result)

                const outputSummary = summarizeToolOutput(result)
                yield* eventStore.publish(
                  new ToolCallCompleted({
                    sessionId: input.sessionId,
                    branchId: input.branchId,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    isError: result.output.type === "error-json",
                    summary: outputSummary,
                    output: stringifyOutput(result.output.value),
                  }),
                )
              }

              const toolResultMessage = new Message({
                id: Bun.randomUUIDv7(),
                sessionId: input.sessionId,
                branchId: input.branchId,
                role: "tool",
                parts: toolResults,
                createdAt: new Date(),
              })
              yield* storage.createMessage(toolResultMessage)
              continueLoop = true
            } else {
              continueLoop = false
            }
          }
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              const error = Cause.pretty(cause)
              yield* eventStore
                .publish(
                  new ErrorOccurred({
                    sessionId: input.sessionId,
                    branchId: input.branchId,
                    error,
                  }),
                )
                .pipe(Effect.catchAll(() => Effect.void))
              return yield* Effect.die(new SubagentError({ message: error, cause }))
            }),
          ),
        )

      const run: AgentActorService["run"] = (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const actor = yield* Machine.spawn(
              AgentMachine.provide({
                run: runEffect,
              }),
              `agent-${input.sessionId}`,
            )

            yield* actor.send(AgentEvent.Start({ input }))

            const terminal = yield* actor.changes.pipe(
              Stream.takeUntil((state) => state._tag === "Completed" || state._tag === "Failed"),
              Stream.runLast,
            )

            if (Option.isSome(terminal) && terminal.value._tag === "Failed") {
              return yield* new SubagentError({ message: terminal.value.error })
            }
          }),
        )

      return AgentActor.of({ run })
    }),
  )
}
