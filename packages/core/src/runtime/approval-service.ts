/**
 * Layer-scoped approval service.
 *
 * Wraps `makeInteractionService` with the fixed approval schema.
 * Long-lived — one instance per server scope, so storedResolutions
 * survive across tool re-executions for cold resume.
 *
 * Tools access this indirectly via `ctx.interaction.approve()` on ToolCapabilityContext.
 */

import { Context, Effect, Layer, Option } from "effect"
import { isRecord } from "../domain/guards.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { InteractionPresented } from "../domain/event.js"
import type { InteractionRequestId } from "../domain/ids.js"
import {
  makeInteractionService,
  type ApprovalDecision,
  type InteractionService,
  type InteractionStorageConfig,
} from "../domain/interaction-request.js"
import type { GentPlatform } from "./gent-platform.js"

export interface ApprovalServiceApi extends InteractionService {}

export class ApprovalService extends Context.Service<ApprovalService, ApprovalServiceApi>()(
  "@gent/core/src/runtime/approval-service/ApprovalService",
) {
  static Live: Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform> = Layer.effect(
    ApprovalService,
    makeApprovalInteractionService(),
  )

  static LiveWithStorage = (
    storage: InteractionStorageConfig,
  ): Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform> =>
    Layer.effect(ApprovalService, makeApprovalInteractionService(storage))

  /** Auto-resolves all approval requests without human interaction.
   *  - ask-user requests → cancelled (don't fabricate user answers)
   *  - all other requests (approval, confirm, review) → approved */
  static LiveAutoResolve: Layer.Layer<ApprovalService> = Layer.succeed(
    ApprovalService,
    ApprovalService.of({
      present: (params) => {
        const meta = Option.fromUndefinedOr(params.metadata).pipe(Option.filter(isRecord))
        const isAskUser = Option.match(meta, {
          onNone: () => false,
          onSome: (value) => value["type"] === "ask-user",
        })
        if (isAskUser) return Effect.succeed({ approved: false })
        return Effect.succeed({ approved: true })
      },
      pendingRequestId: () =>
        Effect.sync(() => Option.getOrUndefined(Option.none<InteractionRequestId>())),
      storeResolution: () => Effect.void,
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    }),
  )

  static Test = (decisions?: ReadonlyArray<ApprovalDecision>): Layer.Layer<ApprovalService> => {
    const queue = [...(decisions ?? [{ approved: true }])]
    return Layer.succeed(
      ApprovalService,
      ApprovalService.of({
        present: () => {
          const decision = Option.getOrElse(Option.fromUndefinedOr(queue.shift()), () => ({
            approved: true,
          }))
          return Effect.succeed(decision)
        },
        pendingRequestId: () =>
          Effect.sync(() => Option.getOrUndefined(Option.none<InteractionRequestId>())),
        storeResolution: () => Effect.void,
        respond: () => Effect.void,
        rehydrate: () => Effect.void,
      }),
    )
  }
}

function makeApprovalInteractionService(
  storage?: InteractionStorageConfig,
): Effect.Effect<InteractionService, never, EventPublisher | GentPlatform> {
  return Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    return yield* makeInteractionService({
      onPresent: (requestId, params, ctx) =>
        eventPublisher.publish(
          InteractionPresented.make({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            requestId,
            text: params.text,
            metadata: params.metadata,
          }),
        ),
      storage,
    })
  })
}
