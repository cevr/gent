import { Context, Deferred, Effect, Layer } from "effect"
import { EventBus, PlanConfirmed, PlanPresented, PlanRejected, type PlanDecision } from "./event"

export interface PlanHandlerService {
  readonly present: (params: {
    sessionId: string
    branchId: string
    planPath?: string
    prompt?: string
  }) => Effect.Effect<PlanDecision>
  readonly respond: (
    requestId: string,
    decision: PlanDecision,
    reason?: string,
  ) => Effect.Effect<void>
}

export class PlanHandler extends Context.Tag("PlanHandler")<PlanHandler, PlanHandlerService>() {
  static Live: Layer.Layer<PlanHandler, never, EventBus> = Layer.effect(
    PlanHandler,
    Effect.gen(function* () {
      const eventBus = yield* EventBus
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<PlanDecision>
          sessionId: string
          branchId: string
          planPath?: string
          prompt?: string
        }
      >()

      return {
        present: Effect.fn("PlanHandler.present")(function* (params) {
          const requestId = Bun.randomUUIDv7()
          const deferred = yield* Deferred.make<PlanDecision>()
          pending.set(requestId, {
            deferred,
            sessionId: params.sessionId,
            branchId: params.branchId,
            planPath: params.planPath,
            prompt: params.prompt,
          })

          yield* eventBus.publish(
            new PlanPresented({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              ...(params.planPath !== undefined ? { planPath: params.planPath } : {}),
              ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
            }),
          )

          const decision = yield* Deferred.await(deferred)
          pending.delete(requestId)
          return decision
        }),

        respond: Effect.fn("PlanHandler.respond")(function* (requestId, decision, reason) {
          const entry = pending.get(requestId)
          if (!entry) return

          if (decision === "confirm") {
            yield* eventBus.publish(
              new PlanConfirmed({
                sessionId: entry.sessionId,
                branchId: entry.branchId,
                requestId,
                ...(entry.planPath !== undefined ? { planPath: entry.planPath } : {}),
              }),
            )
          } else {
            yield* eventBus.publish(
              new PlanRejected({
                sessionId: entry.sessionId,
                branchId: entry.branchId,
                requestId,
                ...(entry.planPath !== undefined ? { planPath: entry.planPath } : {}),
                ...(reason !== undefined ? { reason } : {}),
              }),
            )
          }

          yield* Deferred.succeed(entry.deferred, decision)
          pending.delete(requestId)
        }),
      }
    }),
  )

  static Test = (decisions: ReadonlyArray<PlanDecision> = ["confirm"]): Layer.Layer<PlanHandler> => {
    let index = 0
    return Layer.succeed(PlanHandler, {
      present: () => Effect.succeed(decisions[index++] ?? "confirm"),
      respond: () => Effect.void,
    })
  }
}
