import type { Sharding, Envelope } from "effect/unstable/cluster"
import { Entity } from "effect/unstable/cluster"
import * as TestRunner from "effect/unstable/cluster/TestRunner"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Cause, ServiceMap, Duration, Effect, Layer, Queue, Schedule, Schema } from "effect"
import {
  AgentName,
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
import { AgentLoop } from "./agent"

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
                  yield* eventStore.publish(
                    new ErrorOccurred({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      error: `Agent loop failed: ${cause}`,
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
const GetMetricsRpc = Rpc.make("GetMetrics", {
  payload: ActorTarget.fields,
  success: ActorProcessMetrics,
  error: ActorProcessError,
})

const actorProcessRpcGroup = RpcGroup.make(
  SendUserMessageRpc,
  SendToolResultRpc,
  InterruptRpc,
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
      GetState: (envelope) => actorProcess.getState(envelope.payload),
      GetMetrics: (envelope) => actorProcess.getMetrics(envelope.payload),
    })
  }),
)

export const SessionActorEntityLocalLive = Layer.provide(
  SessionActorEntityLive,
  LocalActorProcessLive,
)

/**
 * Supervised entity using toLayerQueue — persistent mailbox-driven actor.
 *
 * The entity drains a mailbox in an infinite loop. For SendUserMessage,
 * it runs agentLoop.run() inline (blocking the loop — serial turns).
 * If the agent loop defects, the defect propagates up, entity manager
 * restarts the loop with defectRetryPolicy.
 *
 * No forkDetach. The supervised work IS the entity fiber.
 */
export const SessionActorEntitySupervisedLive = SessionActorEntity.toLayerQueue(
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop
    const storage = yield* Storage
    const eventStore = yield* EventStore

    type AnyRpc =
      | typeof SendUserMessageRpc
      | typeof SendToolResultRpc
      | typeof InterruptRpc
      | typeof GetStateRpc
      | typeof GetMetricsRpc

    return (
      queue: Queue.Dequeue<Envelope.Request<AnyRpc>>,
      replier: Entity.Replier<AnyRpc>,
    ): Effect.Effect<never, never, never> =>
      Effect.gen(function* () {
        while (true) {
          const request = yield* Queue.take(queue)

          switch (request.tag) {
            case "SendUserMessage": {
              const input = request.payload as SendUserMessagePayload
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

              // Reply immediately — caller doesn't wait for agent loop
              yield* replier.succeed(request, undefined as void)

              // Run agent loop inline — if this defects, entity restarts
              yield* agentLoop.run(message, { bypass }).pipe(
                Effect.catchCause((cause) => {
                  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                  return eventStore
                    .publish(
                      new ErrorOccurred({
                        sessionId: input.sessionId,
                        branchId: input.branchId,
                        error: `Agent loop failed: ${cause}`,
                      }),
                    )
                    .pipe(Effect.catchEager(() => Effect.void))
                }),
              )
              break
            }

            case "SendToolResult": {
              const input = request.payload as SendToolResultPayload
              yield* replier.complete(
                request,
                yield* Effect.exit(
                  Effect.gen(function* () {
                    const outputType = input.isError === true ? "error-json" : "json"
                    const part = new ToolResultPart({
                      type: "tool-result",
                      toolCallId: input.toolCallId,
                      toolName: input.toolName,
                      output: { type: outputType, value: input.output },
                    })
                    const msg = new Message({
                      id: Bun.randomUUIDv7() as MessageId,
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      role: "tool",
                      parts: [part],
                      createdAt: new Date(),
                    })
                    yield* storage.createMessage(msg)
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
                      isError
                        ? new ToolCallFailed(toolCallFields)
                        : new ToolCallSucceeded(toolCallFields),
                    )
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.fail(wrapError("sendToolResult failed", cause)),
                    ),
                  ),
                ),
              )
              break
            }

            case "Interrupt": {
              const input = request.payload as InterruptPayload
              yield* replier.complete(
                request,
                yield* Effect.exit(
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
                  }).pipe(
                    Effect.catchCause((cause) => Effect.fail(wrapError("interrupt failed", cause))),
                  ),
                ),
              )
              break
            }

            case "GetState": {
              const input = request.payload as ActorTarget
              yield* replier.complete(
                request,
                yield* Effect.exit(
                  Effect.gen(function* () {
                    const running = yield* agentLoop.isRunning(input)
                    return {
                      status: running ? "running" : "idle",
                      agent: undefined,
                      queueDepth: 0,
                      lastError: undefined,
                    } satisfies ActorProcessState
                  }).pipe(
                    Effect.catchCause((cause) => Effect.fail(wrapError("getState failed", cause))),
                  ),
                ),
              )
              break
            }

            case "GetMetrics": {
              yield* replier.succeed(request, {
                turns: 0,
                tokens: 0,
                toolCalls: 0,
                retries: 0,
                durationMs: 0,
              } satisfies ActorProcessMetrics)
              break
            }
          }
        }
      }) as Effect.Effect<never, never, never>
  }),
  {
    defectRetryPolicy: Schedule.both(
      Schedule.exponential(Duration.seconds(1), 2),
      Schedule.recurs(5),
    ),
    maxIdleTime: Duration.minutes(30),
  },
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

/**
 * Supervised ActorProcess using in-memory cluster (TestRunner).
 *
 * Entity runs a mailbox-driven loop — agentLoop.run() executes inline.
 * Defects → entity manager restarts with exponential backoff.
 * No distributed infrastructure required.
 */
export const SupervisedActorProcessLive: Layer.Layer<
  ActorProcess,
  never,
  AgentLoop | Storage | EventStore
> = (() => {
  // TestRunner provides Sharding (in-memory, no SQL)
  // SessionActorEntitySupervisedLive registers the mailbox handler
  // ClusterActorProcessLive routes ActorProcess calls through the entity
  const withEntity = Layer.provideMerge(SessionActorEntitySupervisedLive, TestRunner.layer)
  return Layer.provide(ClusterActorProcessLive, withEntity)
})()
