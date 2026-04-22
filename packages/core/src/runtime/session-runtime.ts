import { Context, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { AgentLoop, AgentLoopError, type AgentLoopService } from "./agent/agent-loop.js"
import {
  ActorProcess,
  ActorProcessError,
  type ActorProcessMetrics,
  type ActorProcessService,
  type ActorProcessState,
  type ActorTarget,
} from "./actor-process.js"
import type { QueueSnapshot } from "../domain/queue.js"

export const SessionRuntimeErrorSchema = Schema.Union([ActorProcessError, AgentLoopError])
export type SessionRuntimeError = typeof SessionRuntimeErrorSchema.Type
export type SessionRuntimeState = ReturnType<AgentLoopService["toRuntimeState"]>

export interface SessionRuntimeService {
  readonly sendUserMessage: (
    input: Parameters<ActorProcessService["sendUserMessage"]>[0],
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly sendToolResult: (
    input: Parameters<ActorProcessService["sendToolResult"]>[0],
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly invokeTool: (
    input: Parameters<ActorProcessService["invokeTool"]>[0],
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly interrupt: (
    input: Parameters<ActorProcessService["interrupt"]>[0],
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly steerAgent: (
    input: Parameters<ActorProcessService["steerAgent"]>[0],
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly drainQueuedMessages: (
    input: ActorTarget,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getQueuedMessages: (
    input: ActorTarget,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getState: (input: ActorTarget) => Effect.Effect<ActorProcessState, SessionRuntimeError>
  readonly getMetrics: (
    input: ActorTarget,
  ) => Effect.Effect<ActorProcessMetrics, SessionRuntimeError>
  readonly respondInteraction: (
    input: Pick<ActorTarget, "sessionId" | "branchId"> & { requestId: string },
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly watchState: (
    input: ActorTarget,
  ) => Effect.Effect<Stream.Stream<SessionRuntimeState>, SessionRuntimeError>
}

export class SessionRuntime extends Context.Service<SessionRuntime, SessionRuntimeService>()(
  "@gent/core/src/runtime/session-runtime/SessionRuntime",
) {
  static Live = Layer.effect(
    SessionRuntime,
    Effect.gen(function* () {
      const actorProcess = yield* ActorProcess
      const agentLoop = yield* AgentLoop

      return {
        sendUserMessage: actorProcess.sendUserMessage,
        sendToolResult: actorProcess.sendToolResult,
        invokeTool: actorProcess.invokeTool,
        interrupt: actorProcess.interrupt,
        steerAgent: actorProcess.steerAgent,
        drainQueuedMessages: actorProcess.drainQueuedMessages,
        getQueuedMessages: actorProcess.getQueuedMessages,
        getState: actorProcess.getState,
        getMetrics: actorProcess.getMetrics,
        respondInteraction: agentLoop.respondInteraction,
        watchState: (input) =>
          Effect.gen(function* () {
            const actor = yield* agentLoop.getActor(input)
            return SubscriptionRef.changes(actor.state).pipe(Stream.map(agentLoop.toRuntimeState))
          }),
      } satisfies SessionRuntimeService
    }),
  )

  static Test = (): Layer.Layer<SessionRuntime> =>
    Layer.succeed(SessionRuntime, {
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
      respondInteraction: () => Effect.void,
      watchState: () => Effect.succeed(Stream.empty),
    })
}
