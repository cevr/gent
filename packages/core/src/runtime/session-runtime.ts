import { Effect, Stream, SubscriptionRef } from "effect"
import type { AgentLoopError, AgentLoopService } from "./agent/agent-loop.js"
import type {
  ActorProcessError,
  ActorProcessService,
  ActorProcessState,
  ActorProcessMetrics,
  ActorTarget,
} from "./actor-process.js"

export interface SessionRuntimeService {
  readonly sendUserMessage: ActorProcessService["sendUserMessage"]
  readonly sendToolResult: ActorProcessService["sendToolResult"]
  readonly invokeTool: ActorProcessService["invokeTool"]
  readonly interrupt: ActorProcessService["interrupt"]
  readonly steerAgent: ActorProcessService["steerAgent"]
  readonly drainQueuedMessages: ActorProcessService["drainQueuedMessages"]
  readonly getQueuedMessages: ActorProcessService["getQueuedMessages"]
  readonly getState: (input: ActorTarget) => Effect.Effect<ActorProcessState, ActorProcessError>
  readonly getMetrics: (input: ActorTarget) => Effect.Effect<ActorProcessMetrics, ActorProcessError>
  readonly watchState: (
    input: ActorTarget,
  ) => Stream.Stream<ReturnType<AgentLoopService["toRuntimeState"]>, AgentLoopError>
}

export const makeSessionRuntimeService = ({
  actorProcess,
  agentLoop,
}: {
  actorProcess: ActorProcessService
  agentLoop: AgentLoopService
}): SessionRuntimeService => ({
  sendUserMessage: actorProcess.sendUserMessage,
  sendToolResult: actorProcess.sendToolResult,
  invokeTool: actorProcess.invokeTool,
  interrupt: actorProcess.interrupt,
  steerAgent: actorProcess.steerAgent,
  drainQueuedMessages: actorProcess.drainQueuedMessages,
  getQueuedMessages: actorProcess.getQueuedMessages,
  getState: actorProcess.getState,
  getMetrics: actorProcess.getMetrics,
  watchState: (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const actor = yield* agentLoop.getActor(input)
        return SubscriptionRef.changes(actor.state).pipe(Stream.map(agentLoop.toRuntimeState))
      }),
    ),
})

export const SessionRuntime = {
  make: makeSessionRuntimeService,
} as const
