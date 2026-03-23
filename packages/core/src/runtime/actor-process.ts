import type { Sharding } from "effect/unstable/cluster"
import { Entity } from "effect/unstable/cluster"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Cause, ServiceMap, Effect, Layer, Schema } from "effect"
import { AgentName } from "../domain/agent.js"
import { QueueSnapshot } from "../domain/queue.js"
import {
  AgentRestarted,
  ErrorOccurred,
  EventStore,
  MessageReceived,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
} from "../domain/event.js"
import { ActorCommandId, BranchId, SessionId, ToolCallId, type MessageId } from "../domain/ids.js"
import { Message, TextPart, ToolCallPart, ToolResultPart } from "../domain/message.js"
import { summarizeToolOutput, stringifyOutput } from "../domain/tool-output.js"
import { Storage } from "../storage/sqlite-storage.js"
import type { ActorInboxRecord } from "./actor-inbox.schema.js"
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
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  mode: Schema.optional(AgentName),
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
      getState: () => Effect.succeed({ status: "idle" as const, queueDepth: 0 }),
      getMetrics: () =>
        Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
    })
}

export class ActorTransport extends ServiceMap.Service<ActorTransport, ActorProcessService>()(
  "@gent/core/src/runtime/actor-process/ActorTransport",
) {}

const toEntityId = (input: ActorTarget) => `${input.sessionId}:${input.branchId}`

const wrapError = (message: string, cause: Cause.Cause<unknown>) =>
  new ActorProcessError({ message, cause })

const makeCommandId = () => Bun.randomUUIDv7() as ActorCommandId
const userMessageIdForCommand = (commandId: ActorCommandId) => commandId as unknown as MessageId
const toolCallIdForCommand = (commandId: ActorCommandId) => commandId as unknown as ToolCallId
const assistantMessageIdForCommand = (commandId: ActorCommandId) =>
  `${commandId}:assistant` as MessageId
const toolResultMessageIdForCommand = (commandId: ActorCommandId) =>
  `${commandId}:tool-result` as MessageId
const followUpMessageIdForCommand = (commandId: ActorCommandId) =>
  `${commandId}:follow-up` as MessageId

export const LocalActorTransportLive: Layer.Layer<
  ActorTransport,
  never,
  AgentLoop | Storage | EventStore | ToolRunner
> = Layer.effect(
  ActorTransport,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop
    const storage = yield* Storage
    const eventStore = yield* EventStore
    const toolRunner = yield* ToolRunner

    return ActorTransport.of({
      sendUserMessage: (input) =>
        Effect.gen(function* () {
          const session = yield* storage.getSession(input.sessionId)
          const bypass = input.bypass ?? session?.bypass ?? true
          const commandId = input.commandId ?? makeCommandId()

          if (input.mode !== undefined) {
            yield* agentLoop.steer({
              _tag: "SwitchAgent",
              sessionId: input.sessionId,
              branchId: input.branchId,
              agent: input.mode,
            })
          }

          const message = new Message({
            id: userMessageIdForCommand(commandId),
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
            createdAt: new Date(),
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

          // Create synthetic assistant message with tool call
          const callPart = new ToolCallPart({
            type: "tool-call",
            toolCallId,
            toolName: input.toolName,
            input: input.input,
          })
          const assistantMessage = new Message({
            id: assistantMessageIdForCommand(commandId),
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "assistant",
            parts: [callPart],
            createdAt: new Date(),
          })
          yield* storage.createMessageIfAbsent(assistantMessage)
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
            id: toolResultMessageIdForCommand(commandId),
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "tool",
            parts: [resultPart],
            createdAt: new Date(),
          })
          yield* storage.createMessageIfAbsent(resultMessage)
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
  AgentLoop | Storage | EventStore | ToolRunner
> = Layer.provide(ActorProcessFromTransportLive, LocalActorTransportLive)

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
const InvokeToolRpc = Rpc.make("InvokeTool", {
  payload: InvokeToolPayload.fields,
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
  success: QueueSnapshot,
  error: ActorProcessError,
})
const GetQueuedMessagesRpc = Rpc.make("GetQueuedMessages", {
  payload: ActorTarget.fields,
  success: QueueSnapshot,
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
  InvokeToolRpc,
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
      InvokeTool: (envelope) => actorProcess.invokeTool(envelope.payload),
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

export const ClusterActorTransportLive: Layer.Layer<ActorTransport, never, Sharding.Sharding> =
  Layer.effect(
    ActorTransport,
    Effect.gen(function* () {
      const clientFor = yield* SessionActorEntity.client
      const client = (input: ActorTarget) => clientFor(toEntityId(input))

      return ActorTransport.of({
        sendUserMessage: (input) =>
          (client(input)["SendUserMessage"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("SendUserMessage failed", cause))),
          ),
        sendToolResult: (input) =>
          (client(input)["SendToolResult"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("SendToolResult failed", cause))),
          ),
        invokeTool: (input) =>
          (client(input)["InvokeTool"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("InvokeTool failed", cause))),
          ),
        interrupt: (input) =>
          (client(input)["Interrupt"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("Interrupt failed", cause))),
          ),
        drainQueuedMessages: (input) =>
          (
            client(input)["DrainQueuedMessages"](input) as Effect.Effect<
              QueueSnapshot,
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
              QueueSnapshot,
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

export const ClusterActorProcessLive: Layer.Layer<ActorProcess, never, Sharding.Sharding> =
  Layer.provide(ActorProcessFromTransportLive, ClusterActorTransportLive)

const parseJson = (json: string): unknown => JSON.parse(json)

const payloadMismatchError = (commandId: ActorCommandId) =>
  new ActorProcessError({ message: `actor command payload mismatch for ${commandId}` })

const receiptExistsForRecord = (
  storage: typeof Storage.Service,
  record: ActorInboxRecord,
): Effect.Effect<boolean, ActorProcessError> =>
  Effect.gen(function* () {
    switch (record.kind) {
      case "send-user-message":
        return (
          (yield* storage
            .getMessage(userMessageIdForCommand(record.commandId))
            .pipe(
              Effect.mapError((cause) =>
                wrapError("reconcile send-user-message failed", Cause.fail(cause)),
              ),
            )) !== undefined
        )
      case "send-tool-result":
      case "invoke-tool":
        return (
          (yield* storage
            .getMessage(toolResultMessageIdForCommand(record.commandId))
            .pipe(
              Effect.mapError((cause) =>
                wrapError(`reconcile ${record.kind} failed`, Cause.fail(cause)),
              ),
            )) !== undefined
        )
      case "interrupt":
      case "steer-agent":
        return false
    }
  })

const markActorCommand = (
  storage: typeof Storage.Service,
  commandId: ActorCommandId,
  fields: Parameters<(typeof Storage.Service)["updateActorInboxRecord"]>[1],
) =>
  storage.updateActorInboxRecord(commandId, fields).pipe(
    Effect.flatMap((record) =>
      record !== undefined
        ? Effect.succeed(record)
        : Effect.fail(new ActorProcessError({ message: `actor command not found: ${commandId}` })),
    ),
    Effect.mapError((cause) => wrapError("actor inbox update failed", Cause.fail(cause))),
  )

const storeActorCommand = (storage: typeof Storage.Service, record: ActorInboxRecord) =>
  storage
    .createActorInboxRecord(record)
    .pipe(Effect.mapError((cause) => wrapError("actor inbox create failed", Cause.fail(cause))))

const loadActorCommand = (storage: typeof Storage.Service, commandId: ActorCommandId) =>
  storage
    .getActorInboxRecord(commandId)
    .pipe(Effect.mapError((cause) => wrapError("actor inbox load failed", Cause.fail(cause))))

const replayStoredCommand = (
  transport: typeof ActorTransport.Service,
  storage: typeof Storage.Service,
  record: ActorInboxRecord,
): Effect.Effect<void, ActorProcessError> =>
  Effect.gen(function* () {
    const hasReceipt = yield* receiptExistsForRecord(storage, record)
    if (hasReceipt) {
      yield* markActorCommand(storage, record.commandId, {
        status: "completed",
        updatedAt: Date.now(),
        completedAt: Date.now(),
        lastError: null,
      })
      return
    }

    yield* markActorCommand(storage, record.commandId, {
      status: "running",
      attempts: record.attempts + 1,
      updatedAt: Date.now(),
      startedAt: Date.now(),
      lastError: null,
    })

    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        switch (record.kind) {
          case "send-user-message":
            return yield* transport.sendUserMessage(
              yield* Schema.decodeUnknownEffect(SendUserMessagePayload)(
                parseJson(record.payloadJson),
              ),
            )
          case "send-tool-result":
            return yield* transport.sendToolResult(
              yield* Schema.decodeUnknownEffect(SendToolResultPayload)(
                parseJson(record.payloadJson),
              ),
            )
          case "invoke-tool":
            return yield* transport.invokeTool(
              yield* Schema.decodeUnknownEffect(InvokeToolPayload)(parseJson(record.payloadJson)),
            )
          case "interrupt":
            return yield* transport.interrupt(
              yield* Schema.decodeUnknownEffect(InterruptPayload)(parseJson(record.payloadJson)),
            )
          case "steer-agent":
            return yield* transport.steerAgent(
              yield* Schema.decodeUnknownEffect(SteerCommand)(parseJson(record.payloadJson)),
            )
        }
      }),
    )

    if (exit._tag === "Success") {
      yield* markActorCommand(storage, record.commandId, {
        status: "completed",
        updatedAt: Date.now(),
        completedAt: Date.now(),
        lastError: null,
      })
      return
    }

    const message = Cause.pretty(exit.cause)
    yield* markActorCommand(storage, record.commandId, {
      status: "failed",
      updatedAt: Date.now(),
      lastError: message,
    })
    return yield* wrapError("actor command replay failed", exit.cause)
  })

export const DurableActorProcessLive: Layer.Layer<ActorProcess, never, ActorTransport | Storage> =
  Layer.effect(
    ActorProcess,
    Effect.gen(function* () {
      const transport = yield* ActorTransport
      const storage = yield* Storage

      const recoverPending = storage.listActorInboxRecordsByStatus(["pending", "running"]).pipe(
        Effect.mapError((cause) =>
          wrapError("actor inbox recovery scan failed", Cause.fail(cause)),
        ),
        Effect.flatMap((records) =>
          Effect.forEach(records, (record) => replayStoredCommand(transport, storage, record), {
            concurrency: 1,
          }),
        ),
        Effect.catchEager((error) => Effect.logWarning("actor inbox recovery failed", error)),
      )

      yield* recoverPending

      const submit = (
        params: {
          commandId: ActorCommandId
          sessionId: SessionId
          branchId: BranchId
          kind: ActorInboxRecord["kind"]
          payloadJson: string
        },
        dispatch: Effect.Effect<void, ActorProcessError>,
      ): Effect.Effect<void, ActorProcessError> =>
        Effect.gen(function* () {
          const existing = yield* loadActorCommand(storage, params.commandId)
          if (existing !== undefined) {
            if (existing.kind !== params.kind || existing.payloadJson !== params.payloadJson) {
              return yield* payloadMismatchError(params.commandId)
            }
            if (existing.status === "completed") return
            return yield* replayStoredCommand(transport, storage, existing)
          }

          const now = Date.now()
          yield* storeActorCommand(storage, {
            commandId: params.commandId,
            sessionId: params.sessionId,
            branchId: params.branchId,
            kind: params.kind,
            payloadJson: params.payloadJson,
            status: "pending",
            attempts: 0,
            createdAt: now,
            updatedAt: now,
          })

          yield* markActorCommand(storage, params.commandId, {
            status: "running",
            attempts: 1,
            updatedAt: Date.now(),
            startedAt: Date.now(),
            lastError: null,
          })

          const exit = yield* Effect.exit(dispatch)
          if (exit._tag === "Success") {
            yield* markActorCommand(storage, params.commandId, {
              status: "completed",
              updatedAt: Date.now(),
              completedAt: Date.now(),
              lastError: null,
            })
            return
          }

          const message = Cause.pretty(exit.cause)
          yield* markActorCommand(storage, params.commandId, {
            status: "failed",
            updatedAt: Date.now(),
            lastError: message,
          })
          return yield* wrapError("actor command failed", exit.cause)
        })

      return ActorProcess.of({
        sendUserMessage: (input) => {
          const commandId = input.commandId ?? makeCommandId()
          const payload = { ...input, commandId }
          return submit(
            {
              commandId,
              sessionId: input.sessionId,
              branchId: input.branchId,
              kind: "send-user-message",
              payloadJson: JSON.stringify(payload),
            },
            transport.sendUserMessage(payload),
          )
        },
        sendToolResult: (input) => {
          const commandId = input.commandId ?? makeCommandId()
          const payload = { ...input, commandId }
          return submit(
            {
              commandId,
              sessionId: input.sessionId,
              branchId: input.branchId,
              kind: "send-tool-result",
              payloadJson: JSON.stringify(payload),
            },
            transport.sendToolResult(payload),
          )
        },
        invokeTool: (input) => {
          const commandId = input.commandId ?? makeCommandId()
          const payload = { ...input, commandId }
          return submit(
            {
              commandId,
              sessionId: input.sessionId,
              branchId: input.branchId,
              kind: "invoke-tool",
              payloadJson: JSON.stringify(payload),
            },
            transport.invokeTool(payload),
          )
        },
        interrupt: (input) => {
          const commandId = input.commandId ?? makeCommandId()
          const payload = { ...input, commandId }
          return submit(
            {
              commandId,
              sessionId: input.sessionId,
              branchId: input.branchId,
              kind: "interrupt",
              payloadJson: JSON.stringify(payload),
            },
            transport.interrupt(payload),
          )
        },
        steerAgent: (command) => {
          const commandId = makeCommandId()
          return submit(
            {
              commandId,
              sessionId: command.sessionId,
              branchId: command.branchId,
              kind: "steer-agent",
              payloadJson: JSON.stringify(command),
            },
            transport.steerAgent(command),
          )
        },
        drainQueuedMessages: transport.drainQueuedMessages,
        getQueuedMessages: transport.getQueuedMessages,
        getState: transport.getState,
        getMetrics: transport.getMetrics,
      })
    }),
  )
