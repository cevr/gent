import { Effect, Layer, Context, Stream, SubscriptionRef } from "effect"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import type { AppServiceError } from "./errors.js"
import type { SessionRuntime, WatchRuntimeInput } from "./transport-contract.js"

export interface SessionSubscriptionsService {
  readonly watchRuntime: (
    input: WatchRuntimeInput,
  ) => Stream.Stream<SessionRuntime, AppServiceError>
}

export class SessionSubscriptions extends Context.Service<
  SessionSubscriptions,
  SessionSubscriptionsService
>()("@gent/core/src/server/session-subscriptions/SessionSubscriptions") {
  static Live = Layer.effect(
    SessionSubscriptions,
    Effect.gen(function* () {
      const agentLoop = yield* AgentLoop

      return {
        watchRuntime: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const actor = yield* agentLoop.getActor(input)
              yield* Effect.logInfo("watchRuntime.open").pipe(
                Effect.annotateLogs({ sessionId: input.sessionId, branchId: input.branchId }),
              )
              return SubscriptionRef.changes(actor.state).pipe(
                Stream.map(agentLoop.toRuntimeState),
                Stream.ensuring(
                  Effect.logInfo("watchRuntime.close").pipe(
                    Effect.annotateLogs({ sessionId: input.sessionId, branchId: input.branchId }),
                  ),
                ),
              )
            }),
          ),
      } satisfies SessionSubscriptionsService
    }),
  )
}
