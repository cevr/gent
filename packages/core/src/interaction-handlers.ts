import { ServiceMap, Deferred, Effect, Layer } from "effect"
import {
  EventStore,
  PermissionRequested,
  type EventStoreError,
  PlanConfirmed,
  PlanPresented,
  PlanRejected,
  type PlanDecision,
  HandoffPresented,
  HandoffConfirmed,
  HandoffRejected,
  type HandoffDecision,
} from "./event"
import type { BranchId, SessionId } from "./ids"
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
        sessionId: SessionId
        branchId: BranchId
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
  >
}

export class PermissionHandler extends ServiceMap.Service<
  PermissionHandler,
  PermissionHandlerService
>()("@gent/core/src/interaction-handlers/PermissionHandler") {
  static Live: Layer.Layer<PermissionHandler, never, EventStore> = Layer.effect(
    PermissionHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<PermissionDecision>
          sessionId: SessionId
          branchId: BranchId
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
    sessionId: SessionId
    branchId: BranchId
    planPath?: string
    prompt?: string
  }) => Effect.Effect<PlanDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: PlanDecision,
    reason?: string,
  ) => Effect.Effect<
    | {
        sessionId: SessionId
        branchId: BranchId
        planPath?: string
      }
    | undefined,
    EventStoreError
  >
}

export class PlanHandler extends ServiceMap.Service<PlanHandler, PlanHandlerService>()(
  "@gent/core/src/interaction-handlers/PlanHandler",
) {
  static Live: Layer.Layer<PlanHandler, never, EventStore> = Layer.effect(
    PlanHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<PlanDecision>
          sessionId: SessionId
          branchId: BranchId
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

// ============================================================================
// Handoff Handler
// ============================================================================

export interface HandoffHandlerService {
  readonly present: (params: {
    sessionId: SessionId
    branchId: BranchId
    summary: string
    reason?: string
  }) => Effect.Effect<HandoffDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    decision: HandoffDecision,
    childSessionId?: SessionId,
    reason?: string,
  ) => Effect.Effect<
    | {
        sessionId: SessionId
        branchId: BranchId
        summary: string
        reason?: string
      }
    | undefined,
    EventStoreError
  >
}

export class HandoffHandler extends ServiceMap.Service<HandoffHandler, HandoffHandlerService>()(
  "@gent/core/src/interaction-handlers/HandoffHandler",
) {
  static Live: Layer.Layer<HandoffHandler, never, EventStore> = Layer.effect(
    HandoffHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const pending = new Map<
        string,
        {
          deferred: Deferred.Deferred<HandoffDecision>
          sessionId: SessionId
          branchId: BranchId
          summary: string
          reason?: string
        }
      >()

      return {
        present: Effect.fn("HandoffHandler.present")(function* (params) {
          const requestId = Bun.randomUUIDv7()
          const deferred = yield* Deferred.make<HandoffDecision>()
          pending.set(requestId, {
            deferred,
            sessionId: params.sessionId,
            branchId: params.branchId,
            summary: params.summary,
            reason: params.reason,
          })

          yield* eventStore.publish(
            new HandoffPresented({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              summary: params.summary,
              ...(params.reason !== undefined ? { reason: params.reason } : {}),
            }),
          )

          const decision = yield* Deferred.await(deferred)
          pending.delete(requestId)
          return decision
        }),

        respond: Effect.fn("HandoffHandler.respond")(
          function* (requestId, decision, childSessionId, reason) {
            const entry = pending.get(requestId)
            if (entry === undefined) return undefined

            // Delete before publishing to prevent double-respond race
            pending.delete(requestId)

            if (decision === "confirm" && childSessionId !== undefined) {
              yield* eventStore.publish(
                new HandoffConfirmed({
                  sessionId: entry.sessionId,
                  branchId: entry.branchId,
                  requestId,
                  childSessionId,
                }),
              )
            } else if (decision === "reject") {
              yield* eventStore.publish(
                new HandoffRejected({
                  sessionId: entry.sessionId,
                  branchId: entry.branchId,
                  requestId,
                  ...(reason !== undefined ? { reason } : {}),
                }),
              )
            }

            yield* Deferred.succeed(entry.deferred, decision)
            return {
              sessionId: entry.sessionId,
              branchId: entry.branchId,
              summary: entry.summary,
              ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
            }
          },
        ),
      }
    }),
  )

  static Test = (
    decisions: ReadonlyArray<HandoffDecision> = ["confirm"],
  ): Layer.Layer<HandoffHandler> => {
    let index = 0
    return Layer.succeed(HandoffHandler, {
      present: () => Effect.succeed(decisions[index++] ?? "confirm"),
      respond: () => Effect.succeed(undefined),
    })
  }
}
