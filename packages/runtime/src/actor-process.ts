import * as Entity from "@effect/cluster/Entity"
import type * as Sharding from "@effect/cluster/Sharding"
import * as Rpc from "@effect/rpc/Rpc"
import * as RpcGroup from "@effect/rpc/RpcGroup"
import { Context, Effect, Layer, Schema } from "effect"
import type * as Cause from "effect/Cause"
import {
  AgentName,
  EventStore,
  Message,
  TextPart,
  ToolCallCompleted,
  ToolResultPart,
  summarizeToolOutput,
  stringifyOutput,
} from "@gent/core"
import { Storage } from "@gent/storage"
import { AgentLoop } from "./agent"

export class ActorProcessError extends Schema.TaggedError<ActorProcessError>()(
  "ActorProcessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const ActorTarget = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
})
export type ActorTarget = typeof ActorTarget.Type

export const SendUserMessagePayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  content: Schema.String,
  mode: Schema.optional(AgentName),
  bypass: Schema.optional(Schema.Boolean),
})
export type SendUserMessagePayload = typeof SendUserMessagePayload.Type

export const SendToolResultPayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
})
export type SendToolResultPayload = typeof SendToolResultPayload.Type

export const InterruptKind = Schema.Literal("cancel", "interrupt", "interject")
export type InterruptKind = typeof InterruptKind.Type

export const InterruptPayload = Schema.Struct({
  sessionId: Schema.String,
  branchId: Schema.String,
  kind: InterruptKind,
  message: Schema.optional(Schema.String),
})
export type InterruptPayload = typeof InterruptPayload.Type

export const ActorProcessStatus = Schema.Literal("idle", "running", "interrupted")
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
  readonly getState: (input: ActorTarget) => Effect.Effect<ActorProcessState, ActorProcessError>
  readonly getMetrics: (input: ActorTarget) => Effect.Effect<ActorProcessMetrics, ActorProcessError>
}

export class ActorProcess extends Context.Tag("@gent/runtime/src/actor-process/ActorProcess")<
  ActorProcess,
  ActorProcessService
>() {}

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
            id: Bun.randomUUIDv7(),
            sessionId: input.sessionId,
            branchId: input.branchId,
            kind: "regular",
            role: "user",
            parts: [new TextPart({ type: "text", text: input.content })],
            createdAt: new Date(),
          })

          yield* Effect.forkDaemon(
            agentLoop.run(message, { bypass }).pipe(Effect.catchAllCause(() => Effect.void)),
          )
        }).pipe(
          Effect.catchAllCause((cause) => Effect.fail(wrapError("sendUserMessage failed", cause))),
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
            id: Bun.randomUUIDv7(),
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "tool",
            parts: [part],
            createdAt: new Date(),
          })

          yield* storage.createMessage(message)
          yield* eventStore.publish(
            new ToolCallCompleted({
              sessionId: input.sessionId,
              branchId: input.branchId,
              toolCallId: input.toolCallId,
              toolName: input.toolName,
              isError: input.isError ?? false,
              summary: summarizeToolOutput(part),
              output: stringifyOutput(part.output.value),
            }),
          )
        }).pipe(
          Effect.catchAllCause((cause) => Effect.fail(wrapError("sendToolResult failed", cause))),
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
        }).pipe(Effect.catchAllCause((cause) => Effect.fail(wrapError("interrupt failed", cause)))),

      getState: (_input) =>
        Effect.gen(function* () {
          const running = yield* agentLoop.isRunning(_input)
          return {
            status: running ? "running" : "idle",
            agent: undefined,
            queueDepth: 0,
            lastError: undefined,
          } satisfies ActorProcessState
        }).pipe(Effect.catchAllCause((cause) => Effect.fail(wrapError("getState failed", cause)))),

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

export class ActorProcessRpcs extends RpcGroup.make(
  Rpc.make("SendUserMessage", {
    payload: SendUserMessagePayload.fields,
    success: Schema.Void,
    error: ActorProcessError,
  }),
  Rpc.make("SendToolResult", {
    payload: SendToolResultPayload.fields,
    success: Schema.Void,
    error: ActorProcessError,
  }),
  Rpc.make("Interrupt", {
    payload: InterruptPayload.fields,
    success: Schema.Void,
    error: ActorProcessError,
  }),
  Rpc.make("GetState", {
    payload: ActorTarget.fields,
    success: ActorProcessState,
    error: ActorProcessError,
  }),
  Rpc.make("GetMetrics", {
    payload: ActorTarget.fields,
    success: ActorProcessMetrics,
    error: ActorProcessError,
  }),
) {}

export const SessionActorEntity = Entity.make("SessionActor", [
  Rpc.make("SendUserMessage", {
    payload: SendUserMessagePayload.fields,
    success: Schema.Void,
    error: ActorProcessError,
  }),
  Rpc.make("SendToolResult", {
    payload: SendToolResultPayload.fields,
    success: Schema.Void,
    error: ActorProcessError,
  }),
  Rpc.make("Interrupt", {
    payload: InterruptPayload.fields,
    success: Schema.Void,
    error: ActorProcessError,
  }),
  Rpc.make("GetState", {
    payload: ActorTarget.fields,
    success: ActorProcessState,
    error: ActorProcessError,
  }),
  Rpc.make("GetMetrics", {
    payload: ActorTarget.fields,
    success: ActorProcessMetrics,
    error: ActorProcessError,
  }),
])

export const SessionActorEntityLive = SessionActorEntity.toLayer(
  Effect.gen(function* () {
    const actorProcess = yield* ActorProcess
    return SessionActorEntity.of({
      SendUserMessage: (request) => actorProcess.sendUserMessage(request.payload),
      SendToolResult: (request) => actorProcess.sendToolResult(request.payload),
      Interrupt: (request) => actorProcess.interrupt(request.payload),
      GetState: (request) => actorProcess.getState(request.payload),
      GetMetrics: (request) => actorProcess.getMetrics(request.payload),
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
          (client(input).SendUserMessage(input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchAllCause((cause) =>
              Effect.fail(wrapError("SendUserMessage failed", cause)),
            ),
          ),
        sendToolResult: (input) =>
          (client(input).SendToolResult(input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchAllCause((cause) => Effect.fail(wrapError("SendToolResult failed", cause))),
          ),
        interrupt: (input) =>
          (client(input).Interrupt(input) as Effect.Effect<void, ActorProcessError>).pipe(
            Effect.catchAllCause((cause) => Effect.fail(wrapError("Interrupt failed", cause))),
          ),
        getState: (input) =>
          (
            client(input).GetState(input) as Effect.Effect<ActorProcessState, ActorProcessError>
          ).pipe(Effect.catchAllCause((cause) => Effect.fail(wrapError("GetState failed", cause)))),
        getMetrics: (input) =>
          (
            client(input).GetMetrics(input) as Effect.Effect<ActorProcessMetrics, ActorProcessError>
          ).pipe(
            Effect.catchAllCause((cause) => Effect.fail(wrapError("GetMetrics failed", cause))),
          ),
      })
    }),
  )
