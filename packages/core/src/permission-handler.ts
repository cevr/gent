import { Context, Deferred, Effect, Layer } from "effect"
import { EventStore, PermissionRequested, type EventStoreError } from "./event"
import type { ToolContext } from "./tool"
import type { PermissionDecision } from "./permission"

export interface PermissionHandlerService {
  readonly request: (
    params: { toolCallId: string; toolName: string; input: unknown },
    ctx: ToolContext,
  ) => Effect.Effect<PermissionDecision, EventStoreError>
  readonly respond: (requestId: string, decision: PermissionDecision) => Effect.Effect<void>
}

export class PermissionHandler extends Context.Tag("PermissionHandler")<
  PermissionHandler,
  PermissionHandlerService
>() {
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
          if (!entry) return
          yield* Deferred.succeed(entry.deferred, decision)
          pending.delete(requestId)
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
      respond: () => Effect.void,
    })
  }
}
