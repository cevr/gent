import { Context, Deferred, Effect, Layer } from "effect"
import {
  EventStore,
  PermissionRequested,
  type EventStoreError,
  PlanConfirmed,
  PlanPresented,
  PlanRejected,
  type PlanDecision,
} from "./event"
import type { ToolContext } from "./tool"
import type { PermissionDecision } from "./permission"

export interface PermissionHandlerService {
  readonly request: (
    params: { toolCallId: string; toolName: string; input: unknown },
    ctx: ToolContext,
  ) => Effect.Effect<PermissionDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PermissionDecision,
  ) => Effect.Effect<
    | {
        sessionId: string
        branchId: string
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
  >
}

export class PermissionHandler extends Context.Tag(
  "@gent/core/src/interaction-handlers/PermissionHandler",
)<PermissionHandler, PermissionHandlerService>() {
  static Live: Layer.Layer<PermissionHandler, never, EventStore> = Layer.effect(
    PermissionHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<PermissionDecision>
          sessionId: string
          branchId: string
          toolCallId: string
          toolName: string
          input: unknown
        }
      >()

      return {
        request: Effect.fn("PermissionHandler.request")(function* (params, ctx) {
          const requestId = Bun.randomUUIDv7()
          const deferred = yield* Deferred.make<PermissionDecision>()
          pending.set(requestId, {
            deferred,
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            toolCallId: params.toolCallId,
            toolName: params.toolName,
            input: params.input,
          })

          yield* eventStore.publish(
            new PermissionRequested({
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
              requestId,
              toolCallId: params.toolCallId,
              toolName: params.toolName,
              ...(params.input !== undefined ? { input: params.input } : {}),
            }),
          )

          const decision = yield* Deferred.await(deferred)
          pending.delete(requestId)
          return decision
        }),

        respond: Effect.fn("PermissionHandler.respond")(function* (requestId, decision) {
          const entry = pending.get(requestId)
          if (entry === undefined) return undefined
          yield* Deferred.succeed(entry.deferred, decision)
          pending.delete(requestId)
          return {
            sessionId: entry.sessionId,
            branchId: entry.branchId,
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            input: entry.input,
          }
        }),
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<PermissionDecision> = ["allow"],
  ): Layer.Layer<PermissionHandler> => {
    let index = 0
    return Layer.succeed(PermissionHandler, {
      request: () => Effect.succeed(decisions[index++] ?? "allow"),
      respond: () => Effect.succeed(undefined),
    })
  }
}

export interface PlanHandlerService {
  readonly present: (params: {
    sessionId: string
    branchId: string
    planPath?: string
    prompt?: string
  }) => Effect.Effect<PlanDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PlanDecision,
    reason?: string,
  ) => Effect.Effect<
    | {
        sessionId: string
        branchId: string
        planPath?: string
      }
    | undefined,
    EventStoreError
  >
}

export class PlanHandler extends Context.Tag("@gent/core/src/interaction-handlers/PlanHandler")<
  PlanHandler,
  PlanHandlerService
>() {
  static Live: Layer.Layer<PlanHandler, never, EventStore> = Layer.effect(
    PlanHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
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

          yield* eventStore.publish(
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
          if (entry === undefined) return undefined

          if (decision === "confirm") {
            yield* eventStore.publish(
              new PlanConfirmed({
                sessionId: entry.sessionId,
                branchId: entry.branchId,
                requestId,
                ...(entry.planPath !== undefined ? { planPath: entry.planPath } : {}),
              }),
            )
          } else {
            yield* eventStore.publish(
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
          return {
            sessionId: entry.sessionId,
            branchId: entry.branchId,
            ...(entry.planPath !== undefined ? { planPath: entry.planPath } : {}),
          }
        }),
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<PlanDecision> = ["confirm"],
  ): Layer.Layer<PlanHandler> => {
    let index = 0
    return Layer.succeed(PlanHandler, {
      present: () => Effect.succeed(decisions[index++] ?? "confirm"),
      respond: () => Effect.succeed(undefined),
    })
  }
}
