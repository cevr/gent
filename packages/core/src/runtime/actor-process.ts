import { Cause, ServiceMap, DateTime, Effect, Layer, Schema, Semaphore } from "effect"
import { AgentName } from "../domain/agent.js"
import { QueueSnapshot } from "../domain/queue.js"
import {
  AgentRestarted,
  ErrorOccurred,
  EventStore,
  ToolCallFailed,
  ToolCallSucceeded,
} from "../domain/event.js"
import { ActorCommandId, BranchId, SessionId, ToolCallId, type MessageId } from "../domain/ids.js"
import { Message, TextPart, ToolResultPart } from "../domain/message.js"
import { summarizeToolOutput, stringifyOutput } from "../domain/tool-output.js"
import { Storage } from "../storage/sqlite-storage.js"
import { invokeToolPhase } from "./agent/agent-loop"
import { ToolRunner } from "./agent/tool-runner"
import { AgentLoop, type SteerCommand } from "./agent"
import { ExtensionRegistry } from "./extensions/registry.js"

export class ActorProcessError extends Schema.TaggedErrorClass<ActorProcessError>()(
  "ActorProcessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ActorTarget = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type ActorTarget = typeof ActorTarget.Type

export const SendUserMessagePayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  agentOverride: Schema.optional(AgentName),
  bypass: Schema.optional(Schema.Boolean),
})
export type SendUserMessagePayload = typeof SendUserMessagePayload.Type

export const SendToolResultPayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
})
export type SendToolResultPayload = typeof SendToolResultPayload.Type

export const InterruptKind = Schema.Literals(["cancel", "interrupt", "interject"])
export type InterruptKind = typeof InterruptKind.Type

export const InterruptPayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  kind: InterruptKind,
  message: Schema.optional(Schema.String),
})
export type InterruptPayload = typeof InterruptPayload.Type

export const InvokeToolPayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  toolName: Schema.String,
  input: Schema.Unknown,
})
export type InvokeToolPayload = typeof InvokeToolPayload.Type

export const ActorProcessStatus = Schema.Literals(["idle", "running", "interrupted"])
export type ActorProcessStatus = typeof ActorProcessStatus.Type
export const ActorProcessPhase = Schema.Literals([
  "idle",
  "resolving",
  "streaming",
  "executing-tools",
  "finalizing",
])
export type ActorProcessPhase = typeof ActorProcessPhase.Type

export const ActorProcessState = Schema.Struct({
  phase: ActorProcessPhase,
  status: ActorProcessStatus,
  agent: Schema.optional(AgentName),
  queue: QueueSnapshot,
  lastError: Schema.optional(Schema.String),
})
export type ActorProcessState = typeof ActorProcessState.Type

export const ActorProcessMetrics = Schema.Struct({
  turns: Schema.Number,
  tokens: Schema.Number,
  toolCalls: Schema.Number,
  retries: Schema.Number,
  durationMs: Schema.Number,
})
export type ActorProcessMetrics = typeof ActorProcessMetrics.Type

export interface ActorProcessService {
  readonly sendUserMessage: (
    input: SendUserMessagePayload,
  ) => Effect.Effect<void, ActorProcessError>
  readonly sendToolResult: (input: SendToolResultPayload) => Effect.Effect<void, ActorProcessError>
  readonly invokeTool: (input: InvokeToolPayload) => Effect.Effect<void, ActorProcessError>
  readonly interrupt: (input: InterruptPayload) => Effect.Effect<void, ActorProcessError>
  readonly steerAgent: (command: SteerCommand) => Effect.Effect<void, ActorProcessError>
  readonly drainQueuedMessages: (
    input: ActorTarget,
  ) => Effect.Effect<QueueSnapshot, ActorProcessError>
  readonly getQueuedMessages: (
    input: ActorTarget,
  ) => Effect.Effect<QueueSnapshot, ActorProcessError>
  readonly getState: (input: ActorTarget) => Effect.Effect<ActorProcessState, ActorProcessError>
  readonly getMetrics: (input: ActorTarget) => Effect.Effect<ActorProcessMetrics, ActorProcessError>
}

export class ActorProcess extends ServiceMap.Service<ActorProcess, ActorProcessService>()(
  "@gent/core/src/runtime/actor-process/ActorProcess",
) {
  static Test = (): Layer.Layer<ActorProcess> =>
    Layer.succeed(ActorProcess, {
      sendUserMessage: () => Effect.void,
      sendToolResult: () => Effect.void,
      invokeTool: () => Effect.void,
      interrupt: () => Effect.void,
      steerAgent: () => Effect.void,
      drainQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
      getState: () =>
        Effect.succeed({
          phase: "idle" as const,
          status: "idle" as const,
          queue: { steering: [], followUp: [] },
        }),
      getMetrics: () =>
        Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
    })
}

class ActorTransport extends ServiceMap.Service<ActorTransport, ActorProcessService>()(
  "@gent/core/src/runtime/actor-process/ActorTransport",
) {}

const wrapError = (message: string, cause: Cause.Cause<unknown>) =>
  new ActorProcessError({ message, cause })

const makeCommandId = () => Bun.randomUUIDv7() as ActorCommandId
const userMessageIdForCommand = (commandId: ActorCommandId) => commandId as string as MessageId
const toolCallIdForCommand = (commandId: ActorCommandId) => commandId as string as ToolCallId
const assistantMessageIdForCommand = (commandId: ActorCommandId) =>
  `${commandId}:assistant` as MessageId
const toolResultMessageIdForCommand = (commandId: ActorCommandId) =>
  `${commandId}:tool-result` as MessageId
const followUpMessageIdForCommand = (commandId: ActorCommandId) =>
  `${commandId}:follow-up` as MessageId

const LocalActorTransportLive: Layer.Layer<
  ActorTransport,
  never,
  AgentLoop | Storage | EventStore | ToolRunner | ExtensionRegistry
> = Layer.effect(
  ActorTransport,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const toolRunner = yield* ToolRunner
    const extensionRegistry = yield* ExtensionRegistry
    const bashSemaphore = yield* Semaphore.make(1)

    return ActorTransport.of({
      sendUserMessage: (input) =>
        Effect.gen(function* () {
          const session = yield* storage.getSession(input.sessionId)
          const bypass = input.bypass ?? session?.bypass ?? true
          const commandId = input.commandId ?? makeCommandId()

          const message = new Message({
            id: userMessageIdForCommand(commandId),
            sessionId: input.sessionId,
            branchId: input.branchId,
            kind: "regular",
            role: "user",
            parts: [new TextPart({ type: "text", text: input.content })],
            createdAt: yield* DateTime.nowAsDate,
          })

          yield* agentLoop
            .submit(message, {
              bypass,
              ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
            })
            .pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                return Effect.gen(function* () {
                  if (Cause.hasDies(cause)) {
                    yield* eventStore.publish(
                      new AgentRestarted({
                        sessionId: input.sessionId,
                        branchId: input.branchId,
                        attempt: 0,
                        error: Cause.pretty(cause),
                      }),
                    )
                  }
                  yield* eventStore.publish(
                    new ErrorOccurred({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      error: Cause.pretty(cause),
                    }),
                  )
                  yield* Effect.logWarning("agent loop submission failed").pipe(
                    Effect.annotateLogs({ error: Cause.pretty(cause) }),
                  )
                }).pipe(Effect.catchEager(() => Effect.void))
              }),
            )
          yield* Effect.logInfo("actor.message.submitted").pipe(
            Effect.annotateLogs({ sessionId: input.sessionId, branchId: input.branchId }),
          )
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(wrapError("sendUserMessage failed", cause))),
        ),

      sendToolResult: (input) =>
        Effect.gen(function* () {
          const commandId = input.commandId ?? makeCommandId()
          const outputType = input.isError === true ? "error-json" : "json"
          const part = new ToolResultPart({
            type: "tool-result",
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            output: { type: outputType, value: input.output },
          })

          const message = new Message({
            id: toolResultMessageIdForCommand(commandId),
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "tool",
            parts: [part],
            createdAt: yield* DateTime.nowAsDate,
          })

          yield* storage.createMessageIfAbsent(message)
          const isError = input.isError ?? false
          const toolCallFields = {
            sessionId: input.sessionId,
            branchId: input.branchId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            summary: summarizeToolOutput(part),
            output: stringifyOutput(part.output.value),
          }
          yield* eventStore.publish(
            isError ? new ToolCallFailed(toolCallFields) : new ToolCallSucceeded(toolCallFields),
          )
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(wrapError("sendToolResult failed", cause))),
        ),

      invokeTool: (input) =>
        Effect.gen(function* () {
          const session = yield* storage.getSession(input.sessionId)
          const bypass = session?.bypass ?? true
          const commandId = input.commandId ?? makeCommandId()
          const toolCallId = toolCallIdForCommand(commandId)
          const currentTurnAgent = (yield* agentLoop.getState(input)).agent

          yield* invokeToolPhase({
            assistantMessageId: assistantMessageIdForCommand(commandId),
            toolResultMessageId: toolResultMessageIdForCommand(commandId),
            toolCallId,
            toolName: input.toolName,
            input: input.input,
            publishEvent: (event) =>
              eventStore.publish(event).pipe(Effect.catchEager(() => Effect.void)),
            sessionId: input.sessionId,
            branchId: input.branchId,
            currentTurnAgent,
            bypass,
            toolRunner,
            extensionRegistry,
            bashSemaphore,
            storage,
          })

          const followUpMessage = new Message({
            id: followUpMessageIdForCommand(commandId),
            sessionId: input.sessionId,
            branchId: input.branchId,
            kind: "regular",
            role: "user",
            parts: [
              new TextPart({
                type: "text",
                text: `Tool ${input.toolName} completed. Review the result and continue.`,
              }),
            ],
            createdAt: yield* DateTime.nowAsDate,
          })

          yield* agentLoop.submit(followUpMessage, { bypass }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              return eventStore
                .publish(
                  new ErrorOccurred({
                    sessionId: input.sessionId,
                    branchId: input.branchId,
                    error: Cause.pretty(cause),
                  }),
                )
                .pipe(Effect.catchEager(() => Effect.void))
            }),
          )
        }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("invokeTool failed", cause)))),

      drainQueuedMessages: (input) =>
        agentLoop
          .drainQueue(input)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.fail(wrapError("drainQueuedMessages failed", cause)),
            ),
          ),

      getQueuedMessages: (input) =>
        agentLoop
          .getQueue(input)
          .pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("getQueuedMessages failed", cause))),
          ),

      interrupt: (input) =>
        Effect.gen(function* () {
          if (input.kind === "interject") {
            if (input.message === undefined || input.message === "") {
              return yield* new ActorProcessError({
                message: "interject requires message",
              })
            }
            yield* agentLoop.steer({
              _tag: "Interject",
              sessionId: input.sessionId,
              branchId: input.branchId,
              message: input.message,
            })
            return
          }

          if (input.kind === "cancel") {
            yield* agentLoop.steer({
              _tag: "Cancel",
              sessionId: input.sessionId,
              branchId: input.branchId,
            })
            return
          }

          yield* agentLoop.steer({
            _tag: "Interrupt",
            sessionId: input.sessionId,
            branchId: input.branchId,
          })
        }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("interrupt failed", cause)))),

      steerAgent: (command) =>
        agentLoop
          .steer(command)
          .pipe(Effect.catchCause((cause) => Effect.fail(wrapError("steerAgent failed", cause)))),

      getState: (_input) =>
        Effect.gen(function* () {
          const loopState = yield* agentLoop.getState(_input)
          return {
            phase: loopState.phase,
            status: loopState.status,
            agent: loopState.agent,
            queue: loopState.queue,
            lastError: undefined,
          } satisfies ActorProcessState
        }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("getState failed", cause)))),

      getMetrics: (input) =>
        storage.listEvents({ sessionId: input.sessionId, branchId: input.branchId }).pipe(
          Effect.map((envelopes) => {
            let turns = 0
            let tokens = 0
            let toolCalls = 0
            let retries = 0
            let durationMs = 0
            for (const { event } of envelopes) {
              switch (event._tag) {
                case "TurnCompleted":
                  turns++
                  durationMs += event.durationMs
                  break
                case "StreamEnded":
                  if (event.usage !== undefined) {
                    tokens += event.usage.inputTokens + event.usage.outputTokens
                  }
                  break
                case "ToolCallStarted":
                  toolCalls++
                  break
                case "ProviderRetrying":
                  retries++
                  break
              }
            }
            return { turns, tokens, toolCalls, retries, durationMs } satisfies ActorProcessMetrics
          }),
          Effect.catchEager(() =>
            Effect.succeed({
              turns: 0,
              tokens: 0,
              toolCalls: 0,
              retries: 0,
              durationMs: 0,
            } satisfies ActorProcessMetrics),
          ),
        ),
    })
  }),
)

const ActorProcessFromTransportLive: Layer.Layer<ActorProcess, never, ActorTransport> =
  Layer.effect(
    ActorProcess,
    Effect.gen(function* () {
      return yield* ActorTransport
    }),
  )

export const LocalActorProcessLive: Layer.Layer<
  ActorProcess,
  never,
  AgentLoop | Storage | EventStore | ToolRunner | ExtensionRegistry
> = Layer.provide(ActorProcessFromTransportLive, LocalActorTransportLive)
