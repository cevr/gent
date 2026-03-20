import type { Sharding } from "effect/unstable/cluster"
import { Entity } from "effect/unstable/cluster"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Cause, ServiceMap, Effect, Layer, Schema } from "effect"
import {
  AgentName,
  AgentRestarted,
  BranchId,
  ErrorOccurred,
  EventStore,
  Message,
  SessionId,
  TextPart,
  ToolCallSucceeded,
  ToolCallFailed,
  ToolResultPart,
  summarizeToolOutput,
  stringifyOutput,
  type MessageId,
} from "@gent/core"
import { Storage } from "@gent/storage"
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
  toolCallId: Schema.String,
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
  readonly interrupt: (input: InterruptPayload) => Effect.Effect<void, ActorProcessError>
  readonly steerAgent: (command: SteerCommand) => Effect.Effect<void, ActorProcessError>
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
      interrupt: () => Effect.void,
      steerAgent: () => Effect.void,
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
  AgentLoop | Storage | EventStore
> = Layer.effect(
  ActorProcess,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop
    const storage = yield* Storage
    const eventStore = yield* EventStore

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
        interrupt: (input) =>
          (client(input)["Interrupt"](input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchCause((cause) => Effect.fail(wrapError("Interrupt failed", cause))),
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
