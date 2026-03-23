import type { Sharding } from "effect/unstable/cluster"
import { Entity } from "effect/unstable/cluster"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Cause, ServiceMap, Effect, Layer, Schema } from "effect"
import { AgentName } from "../domain/agent.js"
import {
  AgentRestarted,
  ErrorOccurred,
  EventStore,
  MessageReceived,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
} from "../domain/event.js"
import { BranchId, SessionId, ToolCallId, type MessageId } from "../domain/ids.js"
import { Message, TextPart, ToolCallPart, ToolResultPart } from "../domain/message.js"
import { summarizeToolOutput, stringifyOutput } from "../domain/tool-output.js"
import { Storage } from "../storage/sqlite-storage.js"
import { ToolRunner } from "./agent/tool-runner"
import { AgentLoop, SteerCommand } from "./agent"

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
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  mode: Schema.optional(AgentName),
  bypass: Schema.optional(Schema.Boolean),
})
export type SendUserMessagePayload = typeof SendUserMessagePayload.Type

export const SendToolResultPayload = Schema.Struct({
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
  sessionId: SessionId,
  branchId: BranchId,
  kind: InterruptKind,
  message: Schema.optional(Schema.String),
})
export type InterruptPayload = typeof InterruptPayload.Type

export const InvokeToolPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  toolName: Schema.String,
  input: Schema.Unknown,
})
export type InvokeToolPayload = typeof InvokeToolPayload.Type

export const ActorProcessStatus = Schema.Literals(["idle", "running", "interrupted"])
export type ActorProcessStatus = typeof ActorProcessStatus.Type

export const ActorProcessState = Schema.Struct({
  status: ActorProcessStatus,
  agent: Schema.optional(AgentName),
  queueDepth: Schema.Number,
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
  ) => Effect.Effect<{ steering: string[]; followUp: string[] }, ActorProcessError>
  readonly getQueuedMessages: (
    input: ActorTarget,
  ) => Effect.Effect<{ steering: string[]; followUp: string[] }, ActorProcessError>
  readonly getState: (input: ActorTarget) => Effect.Effect<ActorProcessState, ActorProcessError>
  readonly getMetrics: (input: ActorTarget) => Effect.Effect<ActorProcessMetrics, ActorProcessError>
}

export class ActorProcess extends ServiceMap.Service<ActorProcess, ActorProcessService>()(
  "@gent/runtime/src/actor-process/ActorProcess",
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
      getState: () => Effect.succeed({ status: "idle" as const, queueDepth: 0 }),
      getMetrics: () =>
        Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
    })
}

const toEntityId = (input: ActorTarget) => `${input.sessionId}:${input.branchId}`

const wrapError = (message: string, cause: Cause.Cause<unknown>) =>
  new ActorProcessError({ message, cause })

export const LocalActorProcessLive: Layer.Layer<
  ActorProcess,
  never,
  AgentLoop | Storage | EventStore | ToolRunner
> = Layer.effect(
  ActorProcess,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const toolRunner = yield* ToolRunner

    return ActorProcess.of({
      sendUserMessage: (input) =>
        Effect.gen(function* () {
          const session = yield* storage.getSession(input.sessionId)
          const bypass = input.bypass ?? session?.bypass ?? true

          if (input.mode !== undefined) {
            yield* agentLoop.steer({
              _tag: "SwitchAgent",
              sessionId: input.sessionId,
              branchId: input.branchId,
              agent: input.mode,
            })
          }

          const message = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            kind: "regular",
            role: "user",
            parts: [new TextPart({ type: "text", text: input.content })],
            createdAt: new Date(),
          })

          yield* Effect.forkDetach(
            agentLoop.run(message, { bypass }).pipe(
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
                  yield* Effect.logWarning("agent loop failed", cause)
                }).pipe(Effect.catchEager(() => Effect.void))
              }),
            ),
          )
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(wrapError("sendUserMessage failed", cause))),
        ),

      sendToolResult: (input) =>
        Effect.gen(function* () {
          const outputType = input.isError === true ? "error-json" : "json"
          const part = new ToolResultPart({
            type: "tool-result",
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            output: { type: outputType, value: input.output },
          })

          const message = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "tool",
            parts: [part],
            createdAt: new Date(),
          })

          yield* storage.createMessage(message)
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
          const toolCallId = Bun.randomUUIDv7() as typeof ToolCallId.Type

          // Create synthetic assistant message with tool call
          const callPart = new ToolCallPart({
            type: "tool-call",
            toolCallId,
            toolName: input.toolName,
            input: input.input,
          })
          const assistantMessage = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "assistant",
            parts: [callPart],
            createdAt: new Date(),
          })
          yield* storage.createMessage(assistantMessage)
          yield* eventStore
            .publish(
              new MessageReceived({
                sessionId: input.sessionId,
                branchId: input.branchId,
                messageId: assistantMessage.id,
                role: "assistant",
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void))

          // Emit tool call started event
          yield* eventStore
            .publish(
              new ToolCallStarted({
                sessionId: input.sessionId,
                branchId: input.branchId,
                toolCallId,
                toolName: input.toolName,
                input: input.input,
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void))

          // Execute tool via ToolRunner
          const ctx = {
            sessionId: input.sessionId,
            branchId: input.branchId,
            toolCallId,
          }
          const resultPart = yield* toolRunner.run(
            { toolCallId, toolName: input.toolName, input: input.input },
            ctx,
            { bypass },
          )

          // Persist tool result message
          const resultMessage = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "tool",
            parts: [resultPart],
            createdAt: new Date(),
          })
          yield* storage.createMessage(resultMessage)
          yield* eventStore
            .publish(
              new MessageReceived({
                sessionId: input.sessionId,
                branchId: input.branchId,
                messageId: resultMessage.id,
                role: "tool",
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void))

          // Emit tool call result event
          const isError = resultPart.output.type === "error-json"
          const toolCallFields = {
            sessionId: input.sessionId,
            branchId: input.branchId,
            toolCallId,
            toolName: input.toolName,
            summary: summarizeToolOutput(resultPart),
            output: stringifyOutput(resultPart.output.value),
          }
          yield* eventStore
            .publish(
              isError ? new ToolCallFailed(toolCallFields) : new ToolCallSucceeded(toolCallFields),
            )
            .pipe(Effect.catchEager(() => Effect.void))

          // Trigger a follow-up LLM turn to react to the tool result
          const followUpMessage = new Message({
            id: Bun.randomUUIDv7() as MessageId,
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
            createdAt: new Date(),
          })

          yield* Effect.forkDetach(
            agentLoop.run(followUpMessage, { bypass }).pipe(
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
            ),
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
          const running = yield* agentLoop.isRunning(_input)
          return {
            status: running ? "running" : "idle",
            agent: undefined,
            queueDepth: 0,
            lastError: undefined,
          } satisfies ActorProcessState
        }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("getState failed", cause)))),

      getMetrics: () =>
        Effect.succeed({
          turns: 0,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
        } satisfies ActorProcessMetrics),
    })
  }),
)

const SendUserMessageRpc = Rpc.make("SendUserMessage", {
  payload: SendUserMessagePayload.fields,
  success: Schema.Void,
  error: ActorProcessError,
})
const SendToolResultRpc = Rpc.make("SendToolResult", {
  payload: SendToolResultPayload.fields,
  success: Schema.Void,
  error: ActorProcessError,
})
const InterruptRpc = Rpc.make("Interrupt", {
  payload: InterruptPayload.fields,
  success: Schema.Void,
  error: ActorProcessError,
})
const DrainQueuedMessagesRpc = Rpc.make("DrainQueuedMessages", {
  payload: ActorTarget.fields,
  success: Schema.Struct({
    steering: Schema.Array(Schema.String),
    followUp: Schema.Array(Schema.String),
  }),
  error: ActorProcessError,
})
const GetQueuedMessagesRpc = Rpc.make("GetQueuedMessages", {
  payload: ActorTarget.fields,
  success: Schema.Struct({
    steering: Schema.Array(Schema.String),
    followUp: Schema.Array(Schema.String),
  }),
  error: ActorProcessError,
})
const GetStateRpc = Rpc.make("GetState", {
  payload: ActorTarget.fields,
  success: ActorProcessState,
  error: ActorProcessError,
})
const SteerAgentRpc = Rpc.make("SteerAgent", {
  payload: { command: SteerCommand },
  success: Schema.Void,
  error: ActorProcessError,
})
const GetMetricsRpc = Rpc.make("GetMetrics", {
  payload: ActorTarget.fields,
  success: ActorProcessMetrics,
  error: ActorProcessError,
})

const actorProcessRpcGroup = RpcGroup.make(
  SendUserMessageRpc,
  SendToolResultRpc,
  InterruptRpc,
  DrainQueuedMessagesRpc,
  GetQueuedMessagesRpc,
  SteerAgentRpc,
  GetStateRpc,
  GetMetricsRpc,
)

export class ActorProcessRpcs extends actorProcessRpcGroup {}

export const SessionActorEntity = Entity.fromRpcGroup("SessionActor", actorProcessRpcGroup)

export const SessionActorEntityLive = SessionActorEntity.toLayer(
  Effect.gen(function* () {
    const actorProcess = yield* ActorProcess
    return SessionActorEntity.of({
      SendUserMessage: (envelope) => actorProcess.sendUserMessage(envelope.payload),
      SendToolResult: (envelope) => actorProcess.sendToolResult(envelope.payload),
      Interrupt: (envelope) => actorProcess.interrupt(envelope.payload),
      DrainQueuedMessages: (envelope) => actorProcess.drainQueuedMessages(envelope.payload),
      GetQueuedMessages: (envelope) => actorProcess.getQueuedMessages(envelope.payload),
      SteerAgent: (envelope) => actorProcess.steerAgent(envelope.payload.command),
      GetState: (envelope) => actorProcess.getState(envelope.payload),
      GetMetrics: (envelope) => actorProcess.getMetrics(envelope.payload),
    })
  }),
)

export const SessionActorEntityLocalLive = Layer.provide(
  SessionActorEntityLive,
  LocalActorProcessLive,
)

export const ClusterActorProcessLive: Layer.Layer<ActorProcess, never, Sharding.Sharding> =
  Layer.effect(
    ActorProcess,
    Effect.gen(function* () {
      const clientFor = yield* SessionActorEntity.client
      const client = (input: ActorTarget) => clientFor(toEntityId(input))

      return ActorProcess.of({
        sendUserMessage: (input) =>
          (client(input)["SendUserMessage"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("SendUserMessage failed", cause))),
          ),
        sendToolResult: (input) =>
          (client(input)["SendToolResult"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("SendToolResult failed", cause))),
          ),
        invokeTool: () =>
          Effect.fail(
            new ActorProcessError({ message: "invokeTool not supported in cluster mode" }),
          ),
        interrupt: (input) =>
          (client(input)["Interrupt"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("Interrupt failed", cause))),
          ),
        drainQueuedMessages: (input) =>
          (
            client(input)["DrainQueuedMessages"](input) as Effect.Effect<
              { steering: string[]; followUp: string[] },
              ActorProcessError
            >
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.fail(wrapError("DrainQueuedMessages failed", cause)),
            ),
          ),
        getQueuedMessages: (input) =>
          (
            client(input)["GetQueuedMessages"](input) as Effect.Effect<
              { steering: string[]; followUp: string[] },
              ActorProcessError
            >
          ).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("GetQueuedMessages failed", cause))),
          ),
        steerAgent: (command) =>
          (
            client(command)["SteerAgent"]({ command }) as Effect.Effect<void, ActorProcessError>
          ).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("SteerAgent failed", cause)))),
        getState: (input) =>
          (
            client(input)["GetState"](input) as Effect.Effect<ActorProcessState, ActorProcessError>
          ).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("GetState failed", cause)))),
        getMetrics: (input) =>
          (
            client(input)["GetMetrics"](input) as Effect.Effect<
              ActorProcessMetrics,
              ActorProcessError
            >
          ).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("GetMetrics failed", cause)))),
      })
    }),
  )
