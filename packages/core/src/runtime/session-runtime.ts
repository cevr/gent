import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { AgentLoop, type AgentLoopError, type AgentLoopService } from "./agent/agent-loop.js"
import {
  ActorProcess,
  type ActorProcessError,
  type ActorProcessMetrics,
  type ActorProcessService,
  type ActorProcessState,
  type ActorTarget,
} from "./actor-process.js"
import type { QueueSnapshot } from "../domain/queue.js"

export interface SessionRuntimeService {
  readonly sendUserMessage: ActorProcessService["sendUserMessage"]
  readonly sendToolResult: ActorProcessService["sendToolResult"]
  readonly invokeTool: ActorProcessService["invokeTool"]
  readonly interrupt: ActorProcessService["interrupt"]
  readonly steerAgent: ActorProcessService["steerAgent"]
  readonly drainQueuedMessages: (
    input: ActorTarget,
  ) => Effect.Effect<QueueSnapshot, ActorProcessError>
  readonly getQueuedMessages: (
    input: ActorTarget,
  ) => Effect.Effect<QueueSnapshot, ActorProcessError>
  readonly getState: (input: ActorTarget) => Effect.Effect<ActorProcessState, ActorProcessError>
  readonly getMetrics: (input: ActorTarget) => Effect.Effect<ActorProcessMetrics, ActorProcessError>
  readonly respondInteraction: (
    input: Pick<ActorTarget, "sessionId" | "branchId"> & { requestId: string },
  ) => Effect.Effect<void>
  readonly watchState: (
    input: ActorTarget,
  ) => Stream.Stream<ReturnType<AgentLoopService["toRuntimeState"]>, AgentLoopError>
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
          Stream.unwrap(
            Effect.gen(function* () {
              const actor = yield* agentLoop.getActor(input)
              return SubscriptionRef.changes(actor.state).pipe(Stream.map(agentLoop.toRuntimeState))
            }),
          ),
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
      watchState: () => Stream.empty,
    })
}
